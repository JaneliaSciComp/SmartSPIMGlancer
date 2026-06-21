#!/usr/bin/env python3
"""
Extract HDF5 chunk indices from Imaris .ims files and write compact .cidx binary files.

Naming follows kerchunk / VirtualiZarr conventions: offset + length per chunk reference.

.cidx format:
  magic:     b"CIDX"
  version:   uint32 LE  (= 1)
  n_levels:  uint32 LE
  For each level (sorted):
    level_idx:     uint32 LE
    n_channels:    uint32 LE
    For each channel (sorted):
      ch_idx:        uint32 LE
      shape[3]:      uint32 LE × 3   (z, y, x — padded HDF5 shape)
      chunk_shape[3]:uint32 LE × 3
      n_chunks[3]:   uint32 LE × 3   (nz, ny, nx)
      table:         nz*ny*nx × 16 bytes
                     [uint64 LE offset, uint64 LE length] per chunk in C order (z,y,x)
                     sentinel for absent chunks: 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF

The table layout is identical to the Zarr v3 sharding_indexed shard index entries,
so the service worker can use it directly when constructing the virtual shard index.
Path is implicit (always the companion .ims file) — no per-entry path field needed.

A companion .meta.json is also written with physical metadata for zarr.json generation.
"""

import h5py
import numpy as np
import json
import struct
import sys
import time
from pathlib import Path

SENTINEL_U64 = np.uint64(2**64 - 1)


def decode_attr(v):
    """Decode Imaris per-character byte array attributes to a Python string."""
    if hasattr(v, "__iter__") and not isinstance(v, (str, bytes, np.ndarray)):
        v = list(v)
    if isinstance(v, (list, np.ndarray)):
        return b"".join(
            x if isinstance(x, bytes) else bytes([int(x)]) for x in v
        ).decode("utf-8")
    return str(v)


def extract(ims_path: Path) -> None:
    cidx_path = ims_path.with_suffix(".cidx")
    meta_path = ims_path.with_suffix(".meta.json")

    print(f"Reading {ims_path.name} …")

    with h5py.File(ims_path, "r") as f:
        img = f["DataSetInfo"]["Image"]
        z0 = int(decode_attr(img.attrs["Z"]))
        y0 = int(decode_attr(img.attrs["Y"]))
        x0 = int(decode_attr(img.attrs["X"]))
        ext_z = float(decode_attr(img.attrs["ExtMax2"]))
        ext_y = float(decode_attr(img.attrs["ExtMax1"]))
        ext_x = float(decode_attr(img.attrs["ExtMax0"]))

        ds = f["DataSet"]
        level_names = sorted(ds.keys())
        n_levels = len(level_names)

        # Read per-channel display info from DataSetInfo/Channel N
        channel_info = {}
        for ch_key in sorted(f["DataSetInfo"].keys()):
            if not ch_key.startswith("Channel "):
                continue
            ch_idx = int(ch_key.split(" ")[1])
            ch_grp = f["DataSetInfo"][ch_key]
            color_str = decode_attr(ch_grp.attrs.get("Color", "1.0 1.0 1.0"))
            rgb = [float(x) for x in color_str.split()]
            hex_color = "#{:02X}{:02X}{:02X}".format(
                round(rgb[0] * 255), round(rgb[1] * 255), round(rgb[2] * 255)
            )
            channel_info[f"c{ch_idx}"] = {
                "imaris_color_rgb": rgb,
                "display_color": hex_color,
            }

        meta = {
            "original_shape": [z0, y0, x0],
            "extent_um": [ext_z, ext_y, ext_x],
            "unit": "micrometer",
            "channel_info": channel_info,
            "levels": {},
        }

        with open(cidx_path, "wb") as out:
            out.write(b"CIDX")
            out.write(struct.pack("<II", 1, n_levels))

            for level_name in level_names:
                level_idx = int(level_name.split(" ")[1])
                tp = ds[level_name]["TimePoint 0"]
                ch_names = sorted(tp.keys())
                n_channels = len(ch_names)

                out.write(struct.pack("<II", level_idx, n_channels))

                level_meta = {}

                for ch_name in ch_names:
                    ch_idx = int(ch_name.split(" ")[1])
                    data = tp[ch_name]["Data"]
                    shape = list(data.shape)        # [z, y, x]
                    cshape = list(data.chunks)      # [cz, cy, cx]
                    nz = shape[0] // cshape[0]
                    ny = shape[1] // cshape[1]
                    nx = shape[2] // cshape[2]
                    n_total = nz * ny * nx

                    out.write(struct.pack("<I", ch_idx))
                    out.write(struct.pack("<3I", *shape))
                    out.write(struct.pack("<3I", *cshape))
                    out.write(struct.pack("<3I", nz, ny, nx))

                    # Collect all chunk info in one C-level sweep via H5Dchunk_iter
                    t0 = time.perf_counter()
                    infos = []
                    data.id.chunk_iter(infos.append)
                    elapsed = time.perf_counter() - t0

                    print(
                        f"  Level {level_idx} ch{ch_idx}: "
                        f"shape={shape} nchunks={nz}×{ny}×{nx}={n_total} "
                        f"(actual={len(infos)}, {elapsed:.1f}s)"
                    )

                    # Build flat table with numpy: index = iz*ny*nx + iy*nx + ix
                    # Each entry: [uint64 offset, uint64 length]; sentinel = 2^64-1
                    table = np.full((n_total, 2), fill_value=SENTINEL_U64, dtype=np.uint64)

                    if infos:
                        co      = np.array([i.chunk_offset[:3] for i in infos], dtype=np.int64)
                        offsets = np.array([i.byte_offset       for i in infos], dtype=np.uint64)
                        lengths = np.array([i.size              for i in infos], dtype=np.uint64)
                        iz = co[:, 0] // cshape[0]
                        iy = co[:, 1] // cshape[1]
                        ix = co[:, 2] // cshape[2]
                        flat = iz * (ny * nx) + iy * nx + ix
                        table[flat, 0] = offsets
                        table[flat, 1] = lengths

                    out.write(table.tobytes())

                    # Actual (unpadded) image size from per-channel HDF5 attributes.
                    # These differ from data.shape which is padded to chunk boundaries.
                    actual_z = int(decode_attr(data.parent.attrs["ImageSizeZ"]))
                    actual_y = int(decode_attr(data.parent.attrs["ImageSizeY"]))
                    actual_x = int(decode_attr(data.parent.attrs["ImageSizeX"]))

                    level_meta[f"c{ch_idx}"] = {
                        "shape": shape,
                        "actual_size": [actual_z, actual_y, actual_x],
                        "chunk_shape": cshape,
                        "n_chunks": [nz, ny, nx],
                        "dtype": str(data.dtype),
                        "scale_um": [
                            ext_z / actual_z,
                            ext_y / actual_y,
                            ext_x / actual_x,
                        ],
                    }

                meta["levels"][f"s{level_idx}"] = level_meta

    with open(meta_path, "w") as mf:
        json.dump(meta, mf, indent=2)

    cidx_size = cidx_path.stat().st_size
    print(f"  → {cidx_path.name}  ({cidx_size / 1e6:.1f} MB)")
    print(f"  → {meta_path.name}")


if __name__ == "__main__":
    targets = sys.argv[1:] or sorted(Path(".").glob("*.ims"))
    for p in targets:
        extract(Path(p))
