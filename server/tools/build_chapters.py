#!/usr/bin/env python3
"""Generate phigros_chapters.json: Phigros chapter/pack membership for the chart library.

Three community datasets are cross-referenced (all fetched through GitHub
mirrors, same chain as fetch_phigros_charts.py):

- ``7aGiven/Phigros_Resource`` info branch — ``info.tsv`` (song ID = stripped
  ``Title.Composer``, the library's identity) and ``single.txt`` (单曲精选集 titles)
- ``sakimidare/Phigros`` — ``Phigros.json``: title -> {composer, chapter}
  (scraped from the Chinese Phigros wiki, CI-updated)
- ``V-Wndr/Phigros_Songinfo`` — ``songlist.json``: title -> {曲包, 备注}
  (includes the 「愚人节」 pack marker)

Song titles are joined after Unicode NFKC + stripping everything that is not a
letter/number/CJK/kana character (case-insensitive). Duplicate titles are
disambiguated by composer. Membership sources are consulted in this order:
sakimidare chapter -> V-Wndr 曲包 -> single.txt (单曲精选集) -> 其他.
Songs in the 「愚人节」 pack belong to 「隐秘」 (hidden), per design.

Output: phigros_chapters.json next to this script — an ordered chapter list
with member song IDs. fetch_phigros_charts.py reads it to stamp a chapter onto
each song's meta.json; the game server serves it so the client can group the
song list by chapter.

Usage (stdlib only)::

    python tools/build_chapters.py            # download inputs via mirrors
    python tools/build_chapters.py --from-dir <dir>   # reuse downloaded inputs
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

# (chapter id, display name, [source-name aliases]); order = display order.
CHAPTERS = [
    ("legacy", "Chapter Legacy 过去的章节", []),
    ("ch5", "Chapter 5 霓虹灯牌", []),
    ("ch6", "Chapter 6 方舟蜃景", []),
    ("ch7", "Chapter 7 时钟链接", []),
    ("ch8", "Chapter 8 凌日潮汐", []),
    ("ch9", "Chapter 9 穹顶孤舟", []),
    ("ss1", "Side Story 1 忘忧宫", []),
    ("ss2", "Side Story 2 弭刻日", []),
    ("ss3", "Side Story 3 盗乐行", []),
    ("ss4", "Side Story 4 无相乡", []),
    ("jixingwei", "极星卫", ["Extra Story Chapter 极星卫", "Extra Story Chapter极星卫"]),
    ("ex-rising", "Chapter Ex-Rising Sun Traxx 精选集", ["Chapter Ex-Rising Sun Traxx"]),
    ("ex-hyun", "Chapter Ex-HyuN 精选集", []),
    ("ex-good", "Chapter Ex-GOOD 精选集", []),
    ("ex-waveat", "Chapter Ex-WAVEAT 精选集", []),
    ("ex-musedash", "Chapter Ex-Muse Dash 精选集", []),
    ("ex-kalpa", "Chapter Ex-KALPA 精选集", []),
    ("ex-lanota", "Chapter Ex-Lanota 精选集", []),
    ("ex-jiang", "Chapter Ex-姜米條 精选集", []),
    ("ex-chaming", "Chapter Ex-茶鸣拾贰律 精选集", []),
    ("ex-overrapid", "Chapter Ex-OverRapid 精选集", []),
    ("ex-rotaeno", "Chapter Ex-Rotaeno 精选集", []),
    ("ex-chunithm", "Chapter Ex-CHUNITHM 精选集", []),
    ("ex-paradigm", "Chapter Ex-Paradigm: Reboot 精选集", ["Chapter Ex-Paradigm:Reboot 精选集"]),
    ("ex-shinobi", "Chapter Ex-SHINOBI SLASH 精选集", []),
    ("ex-takumi", "Chapter Ex-TAKUMI³ 精选集", []),
    ("ex-jiezou", "Chapter Ex-节奏大师 精选集", ["节奏大师精选集"]),
    ("ex-egts", "Chapter Ex-EGTS 精选集", []),
    ("ex-immaculee", "Chapter Ex-Immaculée Sekai 精选集", []),
    ("ex-ongeki", "Chapter Ex-オンゲキ 精选集", []),
    ("ex-maimai", "Chapter Ex-maimai 精选集", []),
    ("ex-liminality", "Chapter Ex-Liminality 精选集", []),
    ("ex-cytus2", "Chapter Ex-CYTUS II 精选集", ["Chapter Ex-CytusII 精选集"]),
    ("single", "单曲精选集", []),
    ("hidden", "隐秘", ["愚人节"]),
    ("other", "其他", ["", "--"]),
]

MIRROR_PREFIXES = ["https://ghfast.top/", "https://gh-proxy.com/", ""]
USER_AGENT = "PhiTogether-ChapterBuilder/1.0"

INPUTS = {
    "info.tsv": "https://raw.githubusercontent.com/7aGiven/Phigros_Resource/info/info.tsv",
    "single.txt": "https://raw.githubusercontent.com/7aGiven/Phigros_Resource/info/single.txt",
    "sakimidare.json": "https://raw.githubusercontent.com/sakimidare/Phigros/main/Phigros.json",
    "vwndr.json": "https://raw.githubusercontent.com/V-Wndr/Phigros_Songinfo/main/songlist.json",
}


def norm_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"[^0-9a-zA-Z一-鿿㐀-䶿぀-ヿ가-힯]", "", value).lower()


def chapter_key(name: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", name or "")).lower()


# source chapter name (normalized) -> chapter id
CHAPTER_BY_KEY: dict[str, str] = {}
for cid, name, aliases in CHAPTERS:
    for variant in [name, *aliases]:
        CHAPTER_BY_KEY[chapter_key(variant)] = cid


def resolve_chapter(source_name: str) -> str | None:
    return CHAPTER_BY_KEY.get(chapter_key(source_name))


def fetch(url: str) -> bytes:
    last_err: Exception | None = None
    for prefix in MIRROR_PREFIXES:
        for attempt in range(2):
            try:
                req = urllib.request.Request(prefix + url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return resp.read()
            except Exception as e:
                last_err = e
    raise RuntimeError(f"cannot download {url}: {last_err}")


def load_inputs(from_dir: Path | None) -> dict[str, str]:
    texts: dict[str, str] = {}
    for name, url in INPUTS.items():
        if from_dir:
            texts[name] = (from_dir / name).read_text(encoding="utf-8")
        else:
            print(f"downloading {name} ...")
            texts[name] = fetch(url).decode("utf-8")
    return texts


def build(texts: dict[str, str]) -> dict:
    # sakimidare: normalized title -> [(title, composer, chapter)]
    saki: dict[str, list[tuple[str, str, str]]] = {}
    for title, meta in json.loads(texts["sakimidare.json"]).items():
        saki.setdefault(norm_title(title), []).append(
            (title, meta.get("composer", ""), meta.get("chapter", ""))
        )
    # also index parenthetical-suffix variants ("Another Me (KALPA)") under the bare title
    saki_bare: dict[str, list[tuple[str, str, str]]] = {}
    for key, rows in saki.items():
        for title, composer, chapter in rows:
            bare = norm_title(re.sub(r"\s*\([^)]*\)\s*$", "", title))
            saki_bare.setdefault(bare, []).append((title, composer, chapter))

    vwndr: dict[str, list[tuple[str, str]]] = {}
    for row in json.loads(texts["vwndr.json"])["data"]:
        vwndr.setdefault(norm_title(row["标题"]), []).append((row["标题"].strip(), row.get("曲包", "")))

    singles = {norm_title(line) for line in texts["single.txt"].splitlines() if line.strip()}

    members: dict[str, list[str]] = {cid: [] for cid, _, _ in CHAPTERS}
    unresolved: list[str] = []

    for line in texts["info.tsv"].splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        song_id, title, composer = parts[0], parts[1], parts[2]
        nt, nc = norm_title(title), norm_title(composer)
        chapter_id = None

        candidates = saki.get(nt) or saki_bare.get(nt) or []
        matched = [c for c in candidates if norm_title(c[1]) == nc] or candidates
        if len(matched) == 1:
            chapter_id = resolve_chapter(matched[0][2])

        if chapter_id is None or chapter_id == "other":
            rows = vwndr.get(nt, [])
            packs = {resolve_chapter(p) for _, p in rows}
            packs.discard(None)
            if len(packs) == 1:
                chapter_id = packs.pop()

        if chapter_id is None or chapter_id == "other":
            if nt in singles:
                chapter_id = "single"

        if chapter_id is None:
            chapter_id = "other"
            unresolved.append(f"{song_id} ({title} / {composer})")
        members[chapter_id].append(song_id)

    return {
        "version": 1,
        "generated_at": datetime.date.today().isoformat(),
        "chapters": [
            {"id": cid, "name": name, "order": i, "songs": members[cid]}
            for i, (cid, name, _) in enumerate(CHAPTERS)
        ],
        "unresolved": unresolved,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from-dir", default=None, help="directory with already-downloaded inputs")
    parser.add_argument("--output", default=None, help="output path (default next to this script)")
    args = parser.parse_args()

    texts = load_inputs(Path(args.from_dir) if args.from_dir else None)
    result = build(texts)
    unresolved = result.pop("unresolved")

    out = Path(args.output) if args.output else Path(__file__).resolve().parent / "phigros_chapters.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    for ch in result["chapters"]:
        print(f"{ch['order']:>2} {ch['id']:<14} {ch['name']:<38} {len(ch['songs'])} songs")
    total = sum(len(ch["songs"]) for ch in result["chapters"])
    print(f"\n{total} songs mapped -> {out}")
    if unresolved:
        print(f"{len(unresolved)} unresolved (fell through to 其他):")
        for line in unresolved:
            print(f"  - {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
