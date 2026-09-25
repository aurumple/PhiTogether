"""Chart discovery/download and the self-hosted best-score leaderboard.

Chart packages (.pez / .zip) are served straight from ``<data_dir>/charts/``;
the operator drops files there manually. No external chart source is involved.

Leaderboard math (aligned with the PhiZone rks convention):
per-chart rks = rating * (acc/100)^2, player rks = mean of the best 30 charts.
Score merge rule matches the game's local best-record logic: higher score wins,
then accuracy, then full-combo.
"""
import json
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from config import get_settings
from database import get_db
from deps import get_current_user, get_user_from_token_or_header

router = APIRouter(prefix="/api/game", tags=["game"])


def get_charts_dir() -> Path:
    return Path(get_settings().charts_dir)


# Validation results are cached per (mtime_ns, size): chart packages can be
# multi-MB and re-parsing them on every listing is wasteful.
_chart_validation_cache: dict[str, tuple[int, int, bool, str]] = {}

# Keep in sync with the frontend import check (extractPez): a chart JSON and an
# audio file must be present; missing illustration/info.txt is tolerated.
_CHART_AUDIO_SUFFIXES = (".ogg", ".mp3", ".wav")


def _validate_chart_package(path: Path) -> tuple[bool, str]:
    try:
        with zipfile.ZipFile(path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            json_names = [i.filename for i in infos if i.filename.lower().endswith(".json")]
            audio_names = [
                i.filename for i in infos if i.filename.lower().endswith(_CHART_AUDIO_SUFFIXES)
            ]
            if not json_names:
                return False, "no chart JSON inside the package"
            if not audio_names:
                return False, "no audio file inside the package"
            # Multiple JSONs: the largest one is most likely the chart itself.
            target = max(json_names, key=lambda n: zf.getinfo(n).file_size)
            with zf.open(target) as f:
                json.loads(f.read().decode("utf-8"))
        return True, ""
    except zipfile.BadZipFile:
        return False, "not a valid zip/pez package"
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "chart JSON cannot be parsed"
    except Exception as e:  # corrupted packages can raise arbitrary zipfile errors
        return False, f"cannot read package: {e}"


def _validate_chart_cached(path: Path) -> tuple[bool, str]:
    stat = path.stat()
    cached = _chart_validation_cache.get(path.name)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2], cached[3]
    result = _validate_chart_package(path)
    _chart_validation_cache[path.name] = (stat.st_mtime_ns, stat.st_size, *result)
    return result


@router.get("/charts")
async def list_charts(user=Depends(get_current_user)):
    """List chart packages under <data_dir>/charts/ with a validity verdict.

    Broken packages are flagged (``valid: false``) so the client can grey them
    out instead of downloading something it cannot import.
    """
    suffixes = {".pez", ".zip"}
    charts: list[dict] = []
    charts_dir = get_charts_dir()
    if charts_dir.is_dir():
        for entry in charts_dir.iterdir():
            if entry.is_file() and entry.suffix.lower() in suffixes:
                valid, error = _validate_chart_cached(entry)
                charts.append({
                    "name": entry.name,
                    "path": f"/api/game/charts/{entry.name}",
                    "size": entry.stat().st_size,
                    "valid": valid,
                    "error": error,
                })
    return {"charts": charts}


@router.get("/charts/{filename}")
async def get_chart_file(filename: str, user=Depends(get_user_from_token_or_header)):
    if Path(filename).name != filename or Path(filename).suffix.lower() not in {".pez", ".zip"}:
        raise HTTPException(status_code=400, detail="Invalid chart filename")
    chart_path = get_charts_dir() / filename
    if not chart_path.is_file():
        raise HTTPException(status_code=404, detail="Chart not found")
    return FileResponse(chart_path, media_type="application/octet-stream", filename=filename)


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
