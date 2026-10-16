# SmartSPIMGlancer

A browser-based viewer for SmartSPIM light-sheet acquisitions stored as Imaris
(`.ims`) files. The `.ims` files are displayed directly in
[Neuroglancer](https://github.com/google/neuroglancer) without converting or
copying the data: a service worker presents each file as a virtual Zarr v3
array, using a precomputed chunk index to point at the compressed HDF5 chunks
inside the original file.

## Repository contents

| Path | Description |
| --- | --- |
| `download_ims.py` | Downloads new `.ims` files from the Keller SmartSPIM IIS listing (`http://keller-s13.hhmi.org/SmartSPIM/`), selected by last-modified date. |
| `extract_index.py` | Reads an `.ims` file and writes a `.cidx` chunk offset/length table and a `.meta.json` file (shape, extent, channel colors, display ranges) next to it. |
| `viewer/index.html` | The viewer UI: dataset and channel selection, legends, and an embedded Neuroglancer iframe. |
| `viewer/sw.js` | Service worker that serves Zarr v3 metadata and virtual shards (the `.ims` bytes plus a synthesized shard index) backed by the `.cidx`/`.meta.json` files. |
| `viewer/neuroglancer/` | Bundled Neuroglancer build used by the viewer. |
| `PIPELINE.md` | Step-by-step process for adding new acquisitions to the viewer. |
| `pixi.toml`, `pixi.lock` | [Pixi](https://pixi.sh) environment (Python, h5py, numpy, zarr). |

`data/` (downloaded `.ims` files and generated indices) is git-ignored.

## Usage

1. Download new acquisitions:
   ```
   ./download_ims.py --since YYYY-MM-DD [--until YYYY-MM-DD] [--dry-run]
   ```
2. Generate the chunk index and metadata:
   ```
   pixi run extract_index data/<file>.ims
   ```
3. Add the dataset to the `#stem-sel` dropdown in `viewer/index.html`.
4. Serve the repository root over HTTP (so `viewer/` and the `data/` files are
   reachable, and the service worker can register) and open `viewer/index.html`.

See [PIPELINE.md](PIPELINE.md) for details, known server issues, and the
antibody panel configuration.

## License

BSD 3-Clause; see [LICENSE](LICENSE). The bundled Neuroglancer build in
`viewer/neuroglancer/` is a third-party component distributed under its own
license (Apache-2.0).
