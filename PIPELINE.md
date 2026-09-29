# SmartSPIM → Neuroglancer pipeline

Process for bringing new SmartSPIM acquisitions from keller-s13 into the viewer.

## 1. Download new `.ims` files

New acquisitions appear as dated subdirectories under
http://keller-s13.hhmi.org/SmartSPIM/, each containing one `.ims` file.

```
./download_ims.py --since YYYY-MM-DD [--until YYYY-MM-DD] [--dry-run] [--dir <dirname>]
```

- Filters directories by the *last-modified* date shown in the IIS listing (not the
  date encoded in the directory name).
- Downloads into `data/`, skips files that already exist there, writes to a `.part`
  file and renames on completion.
- **Known server gotcha:** IIS on keller-s13 has occasionally 404'd on `.ims`
  downloads (`sc-substatus 404.3`, win32 status `50` = `ERROR_NOT_SUPPORTED`) because
  the `.ims` extension wasn't registered in its static-content MIME map. Fix on the
  server (IIS Manager → site → MIME Types → add `.ims` → `application/octet-stream`,
  or `appcmd set config /section:staticContent /+"[fileExtension='.ims',mimeType='application/octet-stream']"`),
  then retry — this is unrelated to file size.

## 2. Extract the chunk index + metadata

```
pixi run extract_index data/<new_file>.ims
```

(or loop over each new `.ims` path). For each file this writes, alongside the `.ims`:

- **`.cidx`** — binary HDF5 chunk offset/length table (kerchunk/VirtualiZarr-style),
  used by the service worker to build virtual Zarr v3 shards without transcoding.
- **`.meta.json`** — physical shape/extent, per-channel Imaris display color
  (`channel_info`), per-level chunking, and per-channel display range
  (`channel_display.p01`/`p99`, floored integers) derived directly from Imaris's
  embedded `Histogram1024` at `DataSet/ResolutionLevel 0/TimePoint 0/Channel N`
  (confirmed to sum to exactly the true unpadded voxel count, so no raw pixel data
  needs to be read).

## 3. Update `viewer/index.html` as needed

- Add an `<option>` for each new dataset stem to `#stem-sel`.
- The viewer distinguishes two antibody panels in the script's `PANELS` object:
  - `LEGACY_STEMS` (the original 4 brains): CD45 (blue) / Olig2 (green) / TH (red).
  - Everything else (`PANELS.current`): CD45/CD8a (yellow) / PaSYN (fuchsia) /
    TH (cyan), plus an optional 4th channel (gray) for samples where an Olig2/
    DyLight755 attempt was made but the antibody didn't work.
  - If a future batch uses yet another panel, add a new entry to `PANELS`, extend
    `LEGACY_STEMS`-style matching logic, and update `panelFor()`.
- Channel dropdown + legend repopulate automatically per selected dataset based on
  the actual channels present in that file's `meta.json` — no other changes needed
  for datasets that fit an existing panel definition.

## Reference

- `download_ims.py`, `extract_index.py` — both in the repo root.
- Antibody panel provenance: see `data/kathy_notes.txt` (legacy panel) and this
  session's history (current panel: CD45/CD8a AF488, PaSYN AF555, TH SeTau647,
  failed Olig2 DyLight755).
