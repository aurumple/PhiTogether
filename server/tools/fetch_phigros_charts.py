#!/usr/bin/env python3
"""Bulk-download the full Phigros chart library into the server's shared chart lib.

Source: the community-extracted resource archive ``7aGiven/Phigros_Resource``
(branches ``info`` / ``chart`` / ``music`` / ``illustration``, see its README).
The archive keeps audio and illustrations **once per song** while charts are
stored per difficulty (``chart/<songID>.0/<LEVEL>.json``), and this tool keeps
that property: each song's audio/cover is downloaded exactly once no matter how
many difficulties it has.

Output layout (default ``<server>/data/charts-lib``)::

    <songID>/
        meta.json          song + per-difficulty metadata (name, rating, charter)
        music.ogg          one audio file per song
        illustration.png   one cover per song
        EZ.json HD.json IN.json [AT.json]

The game server turns each song x difficulty into an on-demand .pez download,
so this raw shared layout is what keeps storage small.

Downloads go through GitHub mirror prefixes first (GitHub is not reliably
reachable from mainland China), falling back to other mirrors and finally
direct raw.githubusercontent.com. Re-running the tool is safe: existing files
are kept and only missing ones are fetched.

Usage (any Python 3.10+, stdlib only)::

    python tools/fetch_phigros_charts.py                 # full library
    python tools/fetch_phigros_charts.py --limit 3       # smoke test
    python tools/fetch_phigros_charts.py --songs Credits.Frums
    python tools/fetch_phigros_charts.py --force         # re-download everything
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO = "7aGiven/Phigros_Resource"
LEVELS = ("EZ", "HD", "IN", "AT")

# Prefixes are tried in order; "" means direct (no mirror). All of these are
# public deployments of hunshcn/gh-proxy-style GitHub accelerators: they accept
# the full GitHub URL appended to the prefix. Prefer the ones that behaved best
# in practice; --mirrors overrides the whole chain.
DEFAULT_MIRRORS = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://gh.nxnow.top/",
    "",
]

USER_AGENT = "PhiTogether-ChartFetcher/1.0"
CHUNK = 256 * 1024


def raw_url(path: str, branch: str = "master") -> str:
    quoted = "/".join(urllib.parse.quote(seg) for seg in path.split("/"))
    return f"https://raw.githubusercontent.com/{REPO}/{branch}/{quoted}"


@dataclass
class Song:
    song_id: str
    name: str
    composer: str
    illustrator: str
    charters: list[str]
    ratings: list[str]

    @property
    def levels(self) -> list[str]:
        return list(LEVELS[: len(self.ratings)])


@dataclass
class Fetcher:
    mirrors: list[str]
    timeout: float
    force: bool
    lock: threading.Lock = field(default_factory=threading.Lock)
    stats: dict = field(default_factory=lambda: {"downloaded": 0, "skipped": 0, "failed": 0})

    def log(self, msg: str) -> None:
        with self.lock:
            print(msg, flush=True)

    def bump(self, key: str) -> None:
        with self.lock:
            self.stats[key] += 1

    def fetch_bytes(self, path: str, branch: str, missing_ok: bool = False) -> bytes | None:
        """Fetch one raw file through the mirror chain. None = confirmed missing."""
        last_err: Exception | None = None
        saw_404 = False
        url = raw_url(path, branch)
        for prefix in self.mirrors:
            for attempt in range(2):
                try:
                    req = urllib.request.Request(prefix + url, headers={"User-Agent": USER_AGENT})
                    with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                        return resp.read()
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        saw_404 = True
                        break  # this mirror reached GitHub; the file really is absent
                    last_err = e
                except Exception as e:  # URLError, timeout, ...
                    last_err = e
                    time.sleep(1 + attempt)
        if saw_404 and missing_ok:
            return None
        raise RuntimeError(f"{path}: {last_err}")

    def fetch_file(self, path: str, branch: str, dest: Path) -> str:
        """Download one file into the shared lib. Returns 'downloaded' | 'skipped' | 'missing'."""
        if dest.exists() and dest.stat().st_size > 0 and not self.force:
            self.bump("skipped")
            return "skipped"
        data = self.fetch_bytes(path, branch, missing_ok=True)
        if data is None:
            return "missing"
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        self.bump("downloaded")
        return "downloaded"


def parse_tsv(text: str) -> list[list[str]]:
    return [line.split("\t") for line in text.splitlines() if line.strip()]


def load_songs(fetcher: Fetcher) -> list[Song]:
    info_rows = parse_tsv(fetcher.fetch_bytes("info.tsv", "info").decode("utf-8"))
    diff_rows = parse_tsv(fetcher.fetch_bytes("difficulty.tsv", "info").decode("utf-8"))
    ratings_by_id = {row[0]: row[1:] for row in diff_rows}
    songs: list[Song] = []
    for row in info_rows:
        song_id = row[0]
        ratings = ratings_by_id.get(song_id)
        if not ratings:
            continue  # archived in info.tsv but no difficulty row yet
        songs.append(
            Song(
                song_id=song_id,
                name=row[1],
                composer=row[2],
                illustrator=row[3],
                charters=row[4:],
                ratings=ratings,
            )
        )
    return songs


def write_meta(song: Song, dest: Path) -> None:
    charts = []
    for i, level in enumerate(song.levels):
        charts.append(
            {
                "level": level,
                "rating": float(song.ratings[i]) if song.ratings[i] else 0.0,
                "charter": song.charters[i] if i < len(song.charters) else "",
                "file": f"{level}.json",
            }
        )
    meta = {
        "id": song.song_id,
        "name": song.name,
        "composer": song.composer,
        "illustrator": song.illustrator,
        "charts": charts,
        "source": "Phigros_Resource",
    }
    dest.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


def fetch_song(song: Song, fetcher: Fetcher, lib_dir: Path) -> list[str]:
    """Fetch one song's assets. Returns a list of problem descriptions."""
    problems: list[str] = []
    song_dir = lib_dir / song.song_id

    # Each asset branch is laid out flat at its root: the branch *is* the folder.
    if fetcher.fetch_file(f"{song.song_id}.ogg", "music", song_dir / "music.ogg") == "missing":
        problems.append("music missing")
    if (
        fetcher.fetch_file(
            f"{song.song_id}.png", "illustration", song_dir / "illustration.png"
        )
        == "missing"
    ):
        problems.append("illustration missing")

    chart_count = 0
    for level in song.levels:
        status = fetcher.fetch_file(
            f"{song.song_id}.0/{level}.json", "chart", song_dir / f"{level}.json"
        )
        if status == "missing":
            problems.append(f"{level} chart missing")
        else:
            chart_count += 1
    if chart_count:
        write_meta(song, song_dir / "meta.json")
    else:
        problems.append("no charts at all")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dest", default=None, help="library directory (default <server>/data/charts-lib)")
    parser.add_argument("--mirrors", default=None, help="comma-separated mirror prefixes, '' for direct")
    parser.add_argument("--direct", action="store_true", help="skip mirrors, use raw.githubusercontent.com")
    parser.add_argument("--force", action="store_true", help="re-download files that already exist")
    parser.add_argument("--limit", type=int, default=0, help="only process the first N songs")
    parser.add_argument("--songs", default="", help="comma-separated song IDs to fetch")
    parser.add_argument("--jobs", type=int, default=4, help="parallel downloads (default 4)")
    parser.add_argument("--timeout", type=float, default=60.0, help="per-request timeout seconds")
    args = parser.parse_args()

    lib_dir = Path(args.dest) if args.dest else Path(__file__).resolve().parent.parent / "data" / "charts-lib"
    if args.direct:
        mirrors = [""]
    elif args.mirrors is not None:
        mirrors = [m.strip() for m in args.mirrors.split(",") if m.strip() or m == ""]
        mirrors = [m for m in mirrors if m != ""] + [""]
    else:
        mirrors = DEFAULT_MIRRORS

    fetcher = Fetcher(mirrors=mirrors, timeout=args.timeout, force=args.force)
    print(f"Target library: {lib_dir}")
    print(f"Mirror chain:   {', '.join(m for m in mirrors if m) or 'direct'}")

    songs = load_songs(fetcher)
    wanted = {s.strip() for s in args.songs.split(",") if s.strip()}
    if wanted:
        songs = [s for s in songs if s.song_id in wanted]
        missing = wanted - {s.song_id for s in songs}
        if missing:
            print(f"WARNING: not in info/difficulty tables: {', '.join(sorted(missing))}")
    if args.limit > 0:
        songs = songs[: args.limit]
    total = len(songs)
    print(f"Songs to process: {total}")
    if not total:
        return 1

    lib_dir.mkdir(parents=True, exist_ok=True)
    failed: list[str] = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(fetch_song, song, fetcher, lib_dir): song for song in songs}
        for fut in concurrent.futures.as_completed(futures):
            song = futures[fut]
            done += 1
            try:
                problems = fut.result()
            except Exception as e:
                fetcher.bump("failed")
                problems = [f"unexpected: {e}"]
            tag = "OK" if not problems else "WARN"
            if problems:
                failed.append(f"{song.song_id}: {', '.join(problems)}")
            print(
                f"[{done}/{total}] {tag} {song.song_id} "
                f"({len(song.levels)} charts) {', '.join(problems)}"
            )

    print(
        f"\nDone. downloaded={fetcher.stats['downloaded']} "
        f"skipped={fetcher.stats['skipped']} failed={fetcher.stats['failed']}"
    )
    if failed:
        print(f"{len(failed)} songs with problems:")
        for line in failed[:20]:
            print(f"  - {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
