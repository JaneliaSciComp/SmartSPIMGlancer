#!/usr/bin/env python3
"""
Download .ims files from the Keller SmartSPIM IIS directory listing.

The listing at BASE_URL contains one subdirectory per acquisition, each
named like "<acqdate>_..._Destripe_DONE" and each holding exactly one
top-level .ims file. Subdirectories are selected by the *last modified*
date shown in the listing (not the date encoded in the directory name),
since that's what changes as new acquisitions finish processing.

Usage:
    ./download_ims.py --since 2026-09-17
    ./download_ims.py --since 2026-09-17 --until 2026-09-18
    ./download_ims.py --dir 20260916_10_48_27_KS_Hom_Atp13a2V990M_ANM585864_Destripe_DONE
    ./download_ims.py --since 2026-09-17 --dry-run
    ./download_ims.py --since 2026-09-17 --dest /nrs/keller/SmartSPIM/data
"""

import argparse
import re
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from html import unescape
from pathlib import Path
from urllib.parse import urljoin

BASE_URL = "http://keller-s13.hhmi.org/SmartSPIM/"
DEST_DIR = Path("/nrs/keller/SmartSPIM/data")

# IIS listing row: "<M>/<D>/<YYYY>  <H>:<MM> <AM|PM>        <dir>&nbsp;or&nbsp;size <A HREF="...">name</A>"
_ROW_RE = re.compile(
    r'(?P<date>\d{1,2}/\d{1,2}/\d{4})\s+(?P<time>\d{1,2}:\d{2}\s*[AP]M)'
    r'\s+(?P<size>&lt;dir&gt;|\d+)\s*<A HREF="(?P<href>[^"]+)">(?P<name>[^<]+)</A>',
    re.IGNORECASE,
)


@dataclass
class Entry:
    name: str
    href: str
    last_modified: datetime
    is_dir: bool


def list_entries(url: str) -> list[Entry]:
    with urllib.request.urlopen(url) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    entries = []
    for m in _ROW_RE.finditer(html):
        entries.append(
            Entry(
                name=unescape(m["name"]).strip(),
                href=m["href"],
                last_modified=datetime.strptime(f"{m['date']} {m['time'].strip()}", "%m/%d/%Y %I:%M %p"),
                is_dir=(m["size"].lower() == "&lt;dir&gt;"),
            )
        )
    return entries


def find_ims_href(base_url: str, dir_entry: Entry) -> str | None:
    dir_url = urljoin(base_url, dir_entry.href)
    for entry in list_entries(dir_url):
        if not entry.is_dir and entry.name.lower().endswith(".ims"):
            return urljoin(dir_url, entry.href)
    return None


def download(url: str, dest: Path, dry_run: bool = False) -> None:
    if dest.exists():
        print(f"  skip (already exists): {dest}")
        return
    if dry_run:
        print(f"  would download: {url} -> {dest}")
        return
    print(f"  downloading: {url} -> {dest}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as f:
        total = int(resp.headers.get("Content-Length", 0))
        written = 0
        chunk_size = 64 * 1024 * 1024
        while chunk := resp.read(chunk_size):
            f.write(chunk)
            written += len(chunk)
            if total:
                print(f"\r    {written / total:.1%} ({written / 1e9:.1f} / {total / 1e9:.1f} GB)", end="")
        print()
    tmp.rename(dest)


def select_directories(
    entries: list[Entry],
    since: datetime | None,
    until: datetime | None,
    names: list[str] | None,
) -> list[Entry]:
    dirs = [e for e in entries if e.is_dir]
    if names:
        wanted = set(names)
        return [e for e in dirs if e.name in wanted]
    return [
        e
        for e in dirs
        if (since is None or e.last_modified >= since) and (until is None or e.last_modified <= until)
    ]


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=BASE_URL, help=f"Directory listing root (default: {BASE_URL})")
    parser.add_argument("--dest", type=Path, default=DEST_DIR, help=f"Destination directory (default: {DEST_DIR})")
    parser.add_argument("--since", type=parse_date, help="Only directories last-modified on/after this date (YYYY-MM-DD)")
    parser.add_argument("--until", type=parse_date, help="Only directories last-modified on/before this date (YYYY-MM-DD)")
    parser.add_argument("--dir", dest="names", action="append", help="Specific directory name to download (repeatable); overrides --since/--until")
    parser.add_argument("--dry-run", action="store_true", help="List what would be downloaded without downloading")
    args = parser.parse_args()

    if not args.names and args.since is None and args.until is None:
        parser.error("specify --since/--until or one or more --dir")

    entries = list_entries(args.base_url)
    selected = select_directories(entries, args.since, args.until, args.names)
    if not selected:
        print("No matching directories found.")
        return 1

    args.dest.mkdir(parents=True, exist_ok=True)

    for d in sorted(selected, key=lambda e: e.last_modified):
        print(f"{d.name}  (last modified {d.last_modified:%Y-%m-%d %H:%M})")
        ims_href = find_ims_href(args.base_url, d)
        if ims_href is None:
            print("  no .ims file found, skipping")
            continue
        filename = Path(ims_href).name
        download(ims_href, args.dest / filename, dry_run=args.dry_run)

    return 0


if __name__ == "__main__":
    sys.exit(main())
