'use strict';
// Service worker: presents IMS files as Zarr v3 arrays backed by virtual shards.
//
// URL scheme (all under the SW scope /viewer/):
//   /viewer/zarr/{stem}/zarr.json                  top-level group
//   /viewer/zarr/{stem}/c{N}/zarr.json             per-channel OME-NGFF multiscale group
//   /viewer/zarr/{stem}/c{N}/s{M}/zarr.json        Zarr v3 array (sharding_indexed + zlib)
//   /viewer/zarr/{stem}/c{N}/s{M}/0/0/0            virtual shard
//
// The virtual shard is the IMS file bytes followed by a synthesised shard index.
// Byte-range requests that fall within [0, imsSize) are forwarded to /{stem}.ims.
// Requests into [imsSize, imsSize+indexSize) return the computed shard index.

// ── CRC32C (Castagnoli) ────────────────────────────────────────────────────
const CRC32C_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32c(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32C_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── .cidx parser ───────────────────────────────────────────────────────────
// Returns Map<levelIdx, Map<chIdx, {shape, chunkShape, nChunks, tableStart, tableEnd, buf}>>
// tableStart/tableEnd are byte offsets into buf (the raw ArrayBuffer).
// The table bytes are uint64 LE pairs [offset, length] in C (z,y,x) order —
// identical to Zarr v3 sharding_indexed shard index entries.
function parseCidx(buf) {
    const v = new DataView(buf);
    let p = 0;

    const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
    if (magic !== 'CIDX') throw new Error(`Bad CIDX magic: ${magic}`);
    p += 4;

    /* version = */ v.getUint32(p, true); p += 4;
    const nLevels = v.getUint32(p, true); p += 4;

    const levels = new Map();

    for (let l = 0; l < nLevels; l++) {
        const levelIdx  = v.getUint32(p, true); p += 4;
        const nChannels = v.getUint32(p, true); p += 4;
        const channels  = new Map();

        for (let c = 0; c < nChannels; c++) {
            const chIdx      = v.getUint32(p, true); p += 4;
            const shape      = [v.getUint32(p, true), v.getUint32(p+4, true), v.getUint32(p+8, true)]; p += 12;
            const chunkShape = [v.getUint32(p, true), v.getUint32(p+4, true), v.getUint32(p+8, true)]; p += 12;
            const nChunks    = [v.getUint32(p, true), v.getUint32(p+4, true), v.getUint32(p+8, true)]; p += 12;

            const tableStart = p;
            const tableEnd   = p + nChunks[0] * nChunks[1] * nChunks[2] * 16;
            p = tableEnd;

            channels.set(chIdx, { shape, chunkShape, nChunks, tableStart, tableEnd, buf });
        }
        levels.set(levelIdx, channels);
    }
    return levels;
}

// ── Data root — where .ims / .cidx / .meta.json files are served from ─────
// Fileglancer share URL for /nrs/keller/SmartSPIM/data/
const DATA_BASE = 'https://fileglancer.int.janelia.org/files/Ydk-A_LUfeQlXbAA/data';

// ── File store (in-memory, survives within a SW lifetime) ──────────────────
const fileStore = new Map(); // stem → { meta, cidx, imsSize }

async function ensureLoaded(stem) {
    if (fileStore.has(stem)) return fileStore.get(stem);

    const [metaResp, cidxResp, headResp] = await Promise.all([
        fetch(`${DATA_BASE}/${stem}.meta.json`),
        fetch(`${DATA_BASE}/${stem}.cidx`),
        fetch(`${DATA_BASE}/${stem}.ims`, { method: 'HEAD' }),
    ]);

    if (!metaResp.ok) throw new Error(`${stem}.meta.json not found (HTTP ${metaResp.status})`);
    if (!cidxResp.ok)  throw new Error(`${stem}.cidx not found (HTTP ${cidxResp.status})`);

    const meta    = await metaResp.json();
    const cidxBuf = await cidxResp.arrayBuffer();
    const imsSize = parseInt(headResp.headers.get('Content-Length'), 10);

    const data = { meta, cidx: parseCidx(cidxBuf), imsSize };
    fileStore.set(stem, data);
    return data;
}

// ── Shard index builder ────────────────────────────────────────────────────
// Returns a Uint8Array: the .cidx table bytes for this channel/level
// followed by the 4-byte little-endian CRC32C of those bytes.
const shardIndexCache = new Map(); // `${stem}/${levelIdx}/${chIdx}` → Uint8Array

function buildShardIndex(stem, levelIdx, chIdx, chData) {
    const key = `${stem}/${levelIdx}/${chIdx}`;
    if (shardIndexCache.has(key)) return shardIndexCache.get(key);

    const { tableStart, tableEnd, buf } = chData;
    const tableBytes = tableEnd - tableStart;
    const result = new Uint8Array(tableBytes + 4);
    result.set(new Uint8Array(buf, tableStart, tableBytes), 0);
    const dv = new DataView(result.buffer, result.byteOffset + tableBytes, 4);
    dv.setUint32(0, crc32c(result.subarray(0, tableBytes)), true);

    shardIndexCache.set(key, result);
    return result;
}

// ── HTTP Range parsing ─────────────────────────────────────────────────────
function parseRange(header, totalSize) {
    // Suffix form:  bytes=-N
    let m = header.match(/^bytes=-(\d+)$/);
    if (m) {
        const n = parseInt(m[1], 10);
        return [totalSize - n, totalSize - 1];
    }
    // Normal form: bytes=start-[end]
    m = header.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end   = m[2] !== '' ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
    return [start, end];
}

// ── Virtual shard handler ──────────────────────────────────────────────────
async function handleShard(stem, levelIdx, chIdx, request) {
    const { cidx, imsSize } = await ensureLoaded(stem);
    const chData = cidx.get(levelIdx)?.get(chIdx);
    if (!chData) return new Response('Level/channel not found', { status: 404 });

    const indexBytes = buildShardIndex(stem, levelIdx, chIdx, chData);
    const indexSize  = indexBytes.byteLength;          // table + CRC32C
    const totalSize  = imsSize + indexSize;
    const imsUrl     = `${DATA_BASE}/${stem}.ims`;

    const rangeHeader = request.headers.get('Range');

    if (!rangeHeader || request.method === 'HEAD') {
        return new Response(null, {
            status: 200,
            headers: {
                'Content-Length': String(totalSize),
                'Accept-Ranges': 'bytes',
                'Content-Type': 'application/octet-stream',
            },
        });
    }

    const parsed = parseRange(rangeHeader, totalSize);
    if (!parsed) return new Response('Bad Range', { status: 400 });
    const [start, end] = parsed;
    const length = end - start + 1;

    if (end < imsSize) {
        // Entirely within IMS file — forward unchanged
        return fetch(imsUrl, { headers: { Range: `bytes=${start}-${end}` } });
    }

    if (start >= imsSize) {
        // Entirely within virtual shard index
        const slice = indexBytes.slice(start - imsSize, end - imsSize + 1);
        return new Response(slice, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Content-Length': String(slice.byteLength),
                'Content-Type': 'application/octet-stream',
            },
        });
    }

    // Straddles boundary: IMS tail + index head
    const imsResp = await fetch(imsUrl, { headers: { Range: `bytes=${start}-${imsSize - 1}` } });
    const imsPart = new Uint8Array(await imsResp.arrayBuffer());
    const idxPart = indexBytes.slice(0, end - imsSize + 1);
    const combined = new Uint8Array(imsPart.byteLength + idxPart.byteLength);
    combined.set(imsPart, 0);
    combined.set(idxPart, imsPart.byteLength);

    return new Response(combined, {
        status: 206,
        headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': String(combined.byteLength),
            'Content-Type': 'application/octet-stream',
        },
    });
}

// ── zarr.json generators ───────────────────────────────────────────────────
function topGroupJson() {
    return JSON.stringify({ zarr_format: 3, node_type: 'group', attributes: {} });
}

function channelGroupJson(meta, chIdx) {
    const levels = meta.levels;
    const levelKeys = Object.keys(levels)
        .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

    // Accumulate half-voxel translation per level.
    // When a level is produced by 2× averaging its predecessor, output voxel j
    // is centered at j·scale_k + 0.5·scale_{k-1} in physical space.
    // Summing across levels: translation[k] = 0.5 · Σ scale[0..k-1]
    const cumTrans = [0, 0, 0];
    const datasets = levelKeys.map(levelKey => {
        const scale = levels[levelKey][`c${chIdx}`].scale_um;
        const translation = [...cumTrans];
        cumTrans[0] += 0.5 * scale[0];
        cumTrans[1] += 0.5 * scale[1];
        cumTrans[2] += 0.5 * scale[2];
        return {
            path: levelKey,
            coordinateTransformations: [
                { type: 'scale',       scale },
                { type: 'translation', translation },
            ],
        };
    });

    return JSON.stringify({
        zarr_format: 3,
        node_type: 'group',
        attributes: {
            ome: {
                version: '0.5',
                multiscales: [{
                    axes: [
                        { name: 'z', type: 'space', unit: 'micrometer' },
                        { name: 'y', type: 'space', unit: 'micrometer' },
                        { name: 'x', type: 'space', unit: 'micrometer' },
                    ],
                    datasets,
                }],
            },
        },
    });
}

function arrayJson(chData) {
    const { shape, chunkShape } = chData;
    return JSON.stringify({
        zarr_format: 3,
        node_type: 'array',
        shape,
        data_type: 'uint16',
        dimension_names: ['z', 'y', 'x'],
        chunk_grid: {
            name: 'regular',
            // outer chunk = full array → exactly one shard, key 0/0/0
            configuration: { chunk_shape: shape },
        },
        chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
        fill_value: 0,
        codecs: [{
            name: 'sharding_indexed',
            configuration: {
                chunk_shape: chunkShape,        // inner chunk matches HDF5 chunks
                codecs: [
                    { name: 'bytes', configuration: { endian: 'little' } },
                    { name: 'zlib',  configuration: { level: 2 } }, // RFC 1950, matches HDF5
                ],
                index_codecs: [
                    { name: 'bytes', configuration: { endian: 'little' } },
                    { name: 'crc32c' },
                ],
                index_location: 'end',
            },
        }],
        attributes: {},
        storage_transformers: [],
    });
}

// ── Route patterns ─────────────────────────────────────────────────────────
// Derive the SW's base path at runtime so this works under any hosting path.
// self.location.pathname is e.g. "/files/dzTXPyl4KCRYdv-2/viewer/sw.js"
const SW_DIR    = self.location.pathname.replace(/\/sw\.js$/, '/');
const ZARR_BASE = SW_DIR + 'zarr/';
const ZARR_PATH = new RegExp(
    '^' + ZARR_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^/]+)/(.*)'
);
const TOP_JSON      = /^zarr\.json$/;
const CH_JSON       = /^c(\d+)\/zarr\.json$/;
const CH_LEVEL_JSON = /^c(\d+)\/s(\d+)\/zarr\.json$/;
const CH_LEVEL_SHARD= /^c(\d+)\/s(\d+)\/c\/0\/0\/0$/;

function jsonResp(body) {
    return new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// ── Fetch intercept ────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const m = new URL(event.request.url).pathname.match(ZARR_PATH);
    if (!m) return;

    const stem = m[1];
    const rest = m[2];

    event.respondWith((async () => {
        try {
            if (TOP_JSON.test(rest)) {
                return jsonResp(topGroupJson());
            }

            const chM = rest.match(CH_JSON);
            if (chM) {
                const { meta } = await ensureLoaded(stem);
                return jsonResp(channelGroupJson(meta, parseInt(chM[1])));
            }

            const lvM = rest.match(CH_LEVEL_JSON);
            if (lvM) {
                const { cidx } = await ensureLoaded(stem);
                const chData = cidx.get(parseInt(lvM[2]))?.get(parseInt(lvM[1]));
                if (!chData) return new Response('Not found', { status: 404 });
                return jsonResp(arrayJson(chData));
            }

            const shM = rest.match(CH_LEVEL_SHARD);
            if (shM) {
                return handleShard(stem, parseInt(shM[2]), parseInt(shM[1]), event.request);
            }

            return new Response('Not found', { status: 404 });
        } catch (err) {
            console.error('[sw]', err);
            return new Response(String(err), { status: 500 });
        }
    })());
});

self.addEventListener('install',  ()  => self.skipWaiting());
self.addEventListener('activate', evt => evt.waitUntil(self.clients.claim()));
