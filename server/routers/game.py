"""Chart discovery/download and the self-hosted best-score leaderboard.

Chart packages (.pez / .zip) are served straight from ``<data_dir>/charts/``;
the operator drops files there manually. In addition, ``<data_dir>/charts-lib``
holds the shared chart library written by ``tools/fetch_phigros_charts.py``
(one audio + one cover per song, one JSON per difficulty): each song/difficulty
is listed as a virtual ``<songID>.<LEVEL>.pez`` and packed into a real .pez on
demand, so the same audio is never stored twice.

Leaderboard math (aligned with the PhiZone rks convention):
per-chart rks = rating * (acc/100)^2, player rks = mean of the best 30 charts.
Score merge rule matches the game's local best-record logic: higher score wins,
then accuracy, then full-combo.
"""
import io
import json
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from config import get_settings
from database import get_db
from deps import get_current_user, get_user_from_token_or_header

router = APIRouter(prefix="/api/game", tags=["game"])

LIB_LEVELS = ("EZ", "HD", "IN", "AT")


def get_charts_dir() -> Path:
    return Path(get_settings().charts_dir)


def get_charts_lib_dir() -> Path:
    return Path(get_settings().charts_lib_dir)


# Validation results are cached per (mtime_ns, size): chart packages can be
# multi-MB and re-parsing them on every listing is wasteful.
_chart_validation_cache: dict[str, tuple[int, int, bool, str, dict]] = {}

# Keep in sync with the frontend import check (extractPez): a chart JSON and an
# audio file must be present; missing illustration/info.txt is tolerated.
_CHART_AUDIO_SUFFIXES = (".ogg", ".mp3", ".wav")


def _parse_info_txt(text: str) -> dict:
    """Best-effort info.txt metadata (same `Key: value` shape the client reads)."""
    meta = {"name": "", "composer": "", "illustrator": "", "charter": "", "level": "", "rating": 0.0}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip().lower(), value.strip()
        if key == "name":
            meta["name"] = value
        elif key == "composer":
            meta["composer"] = value
        elif key == "illustrator":
            meta["illustrator"] = value
        elif key == "charter":
            meta["charter"] = value
        elif key == "level":
            meta["level"] = value
            head = value.split("Lv", 1)[0].strip().upper()
            if head in LIB_LEVELS or head == "SP":
                meta["level"] = head
            try:
                meta["rating"] = float(value.rsplit("Lv", 1)[1].strip())
            except (IndexError, ValueError):
                pass
    return meta


def _validate_chart_package(path: Path) -> tuple[bool, str, dict]:
    try:
        with zipfile.ZipFile(path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            json_names = [i.filename for i in infos if i.filename.lower().endswith(".json")]
            audio_names = [
                i.filename for i in infos if i.filename.lower().endswith(_CHART_AUDIO_SUFFIXES)
            ]
            if not json_names:
                return False, "no chart JSON inside the package", {}
            if not audio_names:
                return False, "no audio file inside the package", {}
            # Multiple JSONs: the largest one is most likely the chart itself.
            target = max(json_names, key=lambda n: zf.getinfo(n).file_size)
            with zf.open(target) as f:
                json.loads(f.read().decode("utf-8"))
            meta: dict = {}
            for i in infos:
                if i.filename.lower().endswith("info.txt"):
                    with zf.open(i) as f:
                        meta = _parse_info_txt(f.read().decode("utf-8", errors="replace"))
                    break
        return True, "", meta
    except zipfile.BadZipFile:
        return False, "not a valid zip/pez package", {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "chart JSON cannot be parsed", {}
    except Exception as e:  # corrupted packages can raise arbitrary zipfile errors
        return False, f"cannot read package: {e}", {}


def _validate_chart_cached(path: Path) -> tuple[bool, str, dict]:
    stat = path.stat()
    cached = _chart_validation_cache.get(path.name)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2], cached[3], cached[4]
    valid, error, meta = _validate_chart_package(path)
    _chart_validation_cache[path.name] = (stat.st_mtime_ns, stat.st_size, valid, error, meta)
    return valid, error, meta


def _lib_song_dirs() -> list[Path]:
    lib_dir = get_charts_lib_dir()
    if not lib_dir.is_dir():
        return []
    return [d for d in lib_dir.iterdir() if d.is_dir() and (d / "meta.json").is_file()]


def _load_chapter_index() -> list[dict]:
    """Ordered chapter list from tools/phigros_chapters.json (empty if absent)."""
    try:
        data = json.loads(Path(get_settings().chapters_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    chapters = data.get("chapters", [])
    chapters.sort(key=lambda c: c.get("order", 999))
    return [
        {"id": c.get("id", ""), "name": c.get("name", ""), "order": c.get("order", 999)}
        for c in chapters
    ]


def _load_lib_meta(song_dir: Path) -> dict | None:
    try:
        return json.loads((song_dir / "meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


@router.get("/charts")
async def list_charts(user=Depends(get_current_user)):
    """List every downloadable chart with metadata for the song browser.

    Two sources are merged:
    - ``<data_dir>/charts/``: .pez/.zip packages dropped in manually, each
      listed as its own entry (``source: "file"``). Broken packages are flagged
      (``valid: false``) so the client can grey them out instead of downloading
      something it cannot import.
    - ``<data_dir>/charts-lib/``: the shared library written by
      tools/fetch_phigros_charts.py; every song x difficulty becomes a virtual
      ``<songID>.<LEVEL>.pez`` entry (``source: "lib"``) that the download
      endpoint packs on demand. Song metadata (cover, ratings, charters) comes
      from the library's meta.json.
    """
    suffixes = {".pez", ".zip"}
    charts: list[dict] = []
    charts_dir = get_charts_dir()
    if charts_dir.is_dir():
        for entry in charts_dir.iterdir():
            if entry.is_file() and entry.suffix.lower() in suffixes:
                valid, error, meta = _validate_chart_cached(entry)
                charts.append({
                    "name": entry.name,
                    "path": f"/api/game/charts/{entry.name}",
                    "size": entry.stat().st_size,
                    "valid": valid,
                    "error": error,
                    "source": "file",
                    "song_id": f"file:{entry.name}",
                    "song_name": meta.get("name") or entry.stem,
                    "composer": meta.get("composer", ""),
                    "illustrator": meta.get("illustrator", ""),
                    "charter": meta.get("charter", ""),
                    "level": meta.get("level", ""),
                    "rating": meta.get("rating", 0.0),
                    "cover": None,
                    "chapter": "",
                    "chapter_order": 999,
                })
    for song_dir in _lib_song_dirs():
        meta = _load_lib_meta(song_dir)
        if not meta:
            continue
        song_id = str(meta.get("id") or song_dir.name)
        music = song_dir / "music.ogg"
        if not music.is_file():
            continue  # nothing playable without audio; the fetch tool reports it
        cover = song_dir / "illustration.png"
        for chart in meta.get("charts", []):
            level = str(chart.get("level", "")).upper()
            chart_file = song_dir / str(chart.get("file") or f"{level}.json")
            if level not in LIB_LEVELS or not chart_file.is_file():
                continue
            charts.append({
                "name": f"{song_id}.{level}.pez",
                "path": f"/api/game/charts/{song_id}.{level}.pez",
                "size": music.stat().st_size
                + chart_file.stat().st_size
                + (cover.stat().st_size if cover.is_file() else 0),
                "valid": True,
                "error": "",
                "source": "lib",
                "song_id": song_id,
                "song_name": meta.get("name") or song_id,
                "composer": meta.get("composer", ""),
                "illustrator": meta.get("illustrator", ""),
                "charter": chart.get("charter", ""),
                "level": level,
                "rating": float(chart.get("rating") or 0),
                "cover": f"/api/game/covers/{song_id}" if cover.is_file() else None,
                "chapter": meta.get("chapter", ""),
                "chapter_order": meta.get("chapter_order", 999),
            })
    return {"charts": charts, "chapters": _load_chapter_index()}


def _parse_lib_filename(filename: str) -> tuple[str, str] | None:
    """``<songID>.<LEVEL>.pez`` -> (song_id, level); song IDs contain dots."""
    if Path(filename).name != filename:
        return None
    stem, suffix = Path(filename).stem, Path(filename).suffix.lower()
    if suffix not in {".pez", ".zip"}:
        return None
    song_id, sep, level = stem.rpartition(".")
    if not sep or not song_id or level.upper() not in LIB_LEVELS:
        return None
    return song_id, level.upper()


def _pack_lib_pez(song_dir: Path, meta: dict, level: str) -> bytes | None:
    """Assemble one .pez from the shared library (audio stored once per song)."""
    chart_meta = next((c for c in meta.get("charts", []) if str(c.get("level", "")).upper() == level), None)
    if not chart_meta:
        return None
    song_id = str(meta.get("id") or song_dir.name)
    chart_path = song_dir / str(chart_meta.get("file") or f"{level}.json")
    music_path = song_dir / "music.ogg"
    cover_path = song_dir / "illustration.png"
    if not chart_path.is_file() or not music_path.is_file():
        return None

    rating = chart_meta.get("rating") or 0
    try:
        rating_text = ("%g" % float(rating))
    except (TypeError, ValueError):
        rating_text = "0"
    info_txt = (
        "#\n"
        f"Name: {meta.get('name') or song_id}\n"
        f"Song: {song_id}.ogg\n"
        f"Picture: {song_id}.png\n"
        f"Chart: {song_id}.json\n"
        f"Level: {level} Lv.{rating_text}\n"
        f"Composer: {meta.get('composer', '')}\n"
        f"Illustrator: {meta.get('illustrator', '')}\n"
        f"Charter: {chart_meta.get('charter', '')}"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("info.txt", info_txt, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr(f"{song_id}.json", chart_path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        # audio/cover are already compressed formats; storing avoids re-deflating MBs
        zf.writestr(f"{song_id}.ogg", music_path.read_bytes(), compress_type=zipfile.ZIP_STORED)
        if cover_path.is_file():
            zf.writestr(f"{song_id}.png", cover_path.read_bytes(), compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()


@router.get("/charts/{filename}")
async def get_chart_file(filename: str, user=Depends(get_user_from_token_or_header)):
    if Path(filename).name != filename or Path(filename).suffix.lower() not in {".pez", ".zip"}:
        raise HTTPException(status_code=400, detail="Invalid chart filename")
    chart_path = get_charts_dir() / filename
    if chart_path.is_file():
        return FileResponse(chart_path, media_type="application/octet-stream", filename=filename)

    # Not a manual package: try the shared library's virtual <songID>.<LEVEL>.pez
    parsed = _parse_lib_filename(filename)
    if not parsed:
        raise HTTPException(status_code=404, detail="Chart not found")
    song_id, level = parsed
    song_dir = get_charts_lib_dir() / song_id
    meta = _load_lib_meta(song_dir) if song_dir.is_dir() else None
    data = _pack_lib_pez(song_dir, meta, level) if meta else None
    if data is None:
        raise HTTPException(status_code=404, detail="Chart not found")
    return Response(
        data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/covers/{song_id}")
async def get_cover(song_id: str, user=Depends(get_user_from_token_or_header)):
    """Cover art for one shared-library song (lazy-loaded by the song list)."""
    if Path(song_id).name != song_id or not song_id:
        raise HTTPException(status_code=400, detail="Invalid song id")
    cover_path = get_charts_lib_dir() / song_id / "illustration.png"
    if not cover_path.is_file():
        raise HTTPException(status_code=404, detail="Cover not found")
    return FileResponse(cover_path, media_type="image/png")


# ===== Self-hosted best-score leaderboard =====

PT_BEST_LIMIT = 30


def _chart_rks(rating: float, acc: float) -> float:
    return round(rating * (acc / 100.0) ** 2, 4)


class PTRecordRequest(BaseModel):
    chart_id: str = Field(min_length=1, max_length=200)
    song_name: str = Field(default="", max_length=200)
    difficulty: str = Field(default="", max_length=50)
    rating: float = Field(default=0, ge=0, le=50)
    score: int = Field(default=0, ge=0, le=10**9)
    acc: float = Field(default=0, ge=0, le=100)
    is_fc: bool = False


def _record_rank_key(score: int, acc: float, is_fc: bool):
    return (score, acc, 1 if is_fc else 0)


@router.post("/pt/records")
async def submit_pt_record(body: PTRecordRequest, user=Depends(get_current_user), db=Depends(get_db)):
    """Upsert the caller's best score for a chart and compute its rks."""
    chart_rks = _chart_rks(body.rating, body.acc)
    cur = await db.execute(
        "SELECT score, acc, is_fc FROM pt_best_records WHERE user_id = ? AND chart_id = ?",
        (user["id"], body.chart_id),
    )
    old = await cur.fetchone()
    improved = old is None or _record_rank_key(body.score, body.acc, body.is_fc) > _record_rank_key(
        old["score"], old["acc"], bool(old["is_fc"])
    )
    if improved:
        await db.execute(
            """INSERT INTO pt_best_records
               (user_id, chart_id, song_name, difficulty, rating, score, acc, is_fc, chart_rks, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(user_id, chart_id) DO UPDATE SET
                 song_name=excluded.song_name, difficulty=excluded.difficulty, rating=excluded.rating,
                 score=excluded.score, acc=excluded.acc, is_fc=excluded.is_fc,
                 chart_rks=excluded.chart_rks, updated_at=excluded.updated_at""",
            (user["id"], body.chart_id, body.song_name, body.difficulty,
             body.rating, body.score, body.acc, 1 if body.is_fc else 0, chart_rks),
        )
        await db.commit()
    return {
        "ok": True,
        "improved": improved,
        "record": {
            "chart_id": body.chart_id, "song_name": body.song_name, "difficulty": body.difficulty,
            "rating": body.rating, "score": body.score, "acc": body.acc,
            "is_fc": body.is_fc, "chart_rks": chart_rks,
        },
    }


async def _user_rks_rows(db, user_id: int | None = None):
    """Mean-of-best-30 rks; user_id=None covers everyone (leaderboard)."""
    condition = f"t.rn <= {PT_BEST_LIMIT}"
    params: tuple = ()
    if user_id is not None:
        condition = f"t.user_id = ? AND {condition}"
        params = (user_id,)
    cur = await db.execute(
        f"""SELECT t.user_id, AVG(t.chart_rks) AS rks, COUNT(*) AS plays
            FROM (SELECT user_id, chart_rks,
                         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY chart_rks DESC) AS rn
                  FROM pt_best_records) t
            WHERE {condition}
            GROUP BY t.user_id""",
        params,
    )
    return {row["user_id"]: dict(row) for row in await cur.fetchall()}


@router.get("/pt/leaderboard")
async def pt_leaderboard(user=Depends(get_current_user), db=Depends(get_db)):
    """Global ranking by mean-of-best-30 rks; display name = nickname or username."""
    stats = await _user_rks_rows(db)
    if not stats:
        return {"entries": [], "my_rank": None, "my_rks": 0.0}
    cur = await db.execute(
        "SELECT id, username, nickname FROM users WHERE id IN "
        f"({','.join('?' * len(stats))})",
        tuple(stats.keys()),
    )
    names = {row["id"]: (row["nickname"] or row["username"]) for row in await cur.fetchall()}
    entries = [
        {"user_id": uid, "name": names.get(uid, f"user{uid}"), "rks": round(s["rks"], 4), "plays": s["plays"]}
        for uid, s in stats.items()
    ]
    entries.sort(key=lambda e: e["rks"], reverse=True)
    my_rank = next((i + 1 for i, e in enumerate(entries) if e["user_id"] == user["id"]), None)
    return {
        "entries": entries,
        "my_rank": my_rank,
        "my_rks": round(stats[user["id"]]["rks"], 4) if user["id"] in stats else 0.0,
    }


@router.get("/pt/me")
async def my_pt_records(user=Depends(get_current_user), db=Depends(get_db)):
    """The caller's best-30 detail rows plus overall rks."""
    cur = await db.execute(
        """SELECT chart_id, song_name, difficulty, rating, score, acc, is_fc, chart_rks, updated_at
           FROM pt_best_records WHERE user_id = ?
           ORDER BY chart_rks DESC LIMIT ?""",
        (user["id"], PT_BEST_LIMIT),
    )
    records = [dict(row) for row in await cur.fetchall()]
    stats = await _user_rks_rows(db, user["id"])
    return {
        "records": records,
        "rks": round(stats[user["id"]]["rks"], 4) if user["id"] in stats else 0.0,
        "limit": PT_BEST_LIMIT,
    }
