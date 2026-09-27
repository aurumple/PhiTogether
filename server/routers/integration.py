"""OneTap 集成模式：宿主游戏网关（loopback）专用的 /int/v1/* 固定契约。

与独立模式（/api/*、SPA、JWT、注册/登录/刷新）互斥，只在 PT_ONETAP_INTEGRATION=1
时装配。身份一律来自网关注入的 X-OT-Subject 外部主体；服务密钥（X-OT-Service-Key）
验证通过之前绝不解析主体，也绝不从 query/body 接受身份。没有“第一个访问者是管理员”，
也没有任何 query token 绕过路径。

对外错误统一 {"error":{"code","message"}}，code 取值与宿主网关可识别的类别一致
（ACCESS_DENIED / NOT_FOUND / REQUEST_INVALID / CONFLICT / RATE_LIMITED /
QUOTA_EXCEEDED / SERVICE_UNAVAILABLE）：服务故障绝不伪装成未登录。
"""
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

from config import get_settings
from database import get_onetap_db, init_onetap_db
from routers.game import (
    PT_BEST_LIMIT,
    _load_chapter_index,
    _user_rks_rows,
    _write_lib_pez,
    collect_chart_entries,
    get_charts_dir,
    get_charts_lib_dir,
    load_me_records,
    merge_pt_record,
    rank_chart_rows,
    resolve_chart_package,
    select_top_and_me,
)

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/int/v1", tags=["integration"])

SERVICE_KEY_HEADER = "X-OT-Service-Key"
SUBJECT_HEADER = "X-OT-Subject"
PROTOCOL = 1

# 与宿主网关的 contentId 白名单同形。谱库 songID 含非 ASCII（如日文歌名），
# 不能只限 ASCII：这里禁的是路径分隔、控制字符与父目录引用（防穿越），其余字符放行。
CONTENT_ID_RE = re.compile(r"[^\x00-\x1f\x7f/\\]{1,128}\Z")
CHART_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
RANGE_RE = re.compile(r"bytes=(\d+)-(\d*)\Z")

CHUNK = 64 * 1024

_STATUS_CODES = {
    400: "REQUEST_INVALID",
    401: "ACCESS_DENIED",
    403: "ACCESS_DENIED",
    404: "NOT_FOUND",
    409: "CONFLICT",
    416: "REQUEST_INVALID",
    429: "RATE_LIMITED",
}


def _error(code: str, message: str, status: int) -> HTTPException:
    """统一错误信封；由应用的异常处理器序列化成 {"error":{"code","message"}}。"""
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# ===== 门槛：服务密钥 → 外部主体 → 内部用户映射 =====


def _check_service_key(request: Request) -> None:
    """常数时间比较服务密钥；验证通过前不读、不解析任何主体字段。"""
    provided = request.headers.get(SERVICE_KEY_HEADER) or ""
    expected = get_settings().onetap_service_key
    if not secrets.compare_digest(
        provided.encode("utf-8"), expected.encode("utf-8")
    ):
        raise _error("ACCESS_DENIED", "服务密钥无效", 403)


async def verify_service_key(request: Request) -> None:
    """仅验密钥的门槛（/status 用：宿主查可用性时可能没有主体）。"""
    _check_service_key(request)


def _parse_subject(raw: str) -> dict:
    """外部主体形状校验：installationId/accountId 是 ≤64 字符稳定标识，
    displayName ≤120，sponsor 严格布尔。形状不对一律 REQUEST_INVALID，不部分接受。
    """
    if len(raw) > 1024:
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    try:
        data = json.loads(raw)
    except ValueError:
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    if not isinstance(data, dict):
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    installation_id = data.get("installationId")
    account_id = data.get("accountId")
    display_name = data.get("displayName")
    sponsor = data.get("sponsor")
    if not isinstance(installation_id, str) or not 1 <= len(installation_id) <= 64:
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    if not isinstance(account_id, str) or not 1 <= len(account_id) <= 64:
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    if not isinstance(display_name, str) or len(display_name) > 120:
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    if type(sponsor) is not bool:
        raise _error("REQUEST_INVALID", "主体格式无效", 400)
    return {
        "installation_id": installation_id,
        "account_id": account_id,
        "display_name": display_name,
        "sponsor": sponsor,
    }


def _unusable_password() -> str:
    """内部用户没有密码：随机不可用值，登录路径永远不可能撞对。"""
    return "unusable:" + secrets.token_urlsafe(24)


async def _find_mapping(db, installation_id: str, account_id: str):
    cur = await db.execute(
        "SELECT s.user_id, s.display_name, s.sponsor, u.username, u.nickname"
        " FROM onetap_subjects s JOIN users u ON u.id = s.user_id"
        " WHERE s.installation_id = ? AND s.account_id = ?",
        (installation_id, account_id),
    )
    return await cur.fetchone()


async def _refresh_mapping(db, row, subject: dict) -> dict:
    """改名只刷新 nickname 与映射行展示缓存，不改变身份；无变化就不写库，
    让纯读请求（排行榜刷新）不抢 SQLite 写锁。
    """
    changed = False
    if row["nickname"] != subject["display_name"]:
        await db.execute(
            "UPDATE users SET nickname = ? WHERE id = ?",
            (subject["display_name"], row["user_id"]),
        )
        changed = True
    if row["display_name"] != subject["display_name"] or bool(row["sponsor"]) != subject["sponsor"]:
        await db.execute(
            "UPDATE onetap_subjects SET display_name = ?, sponsor = ?"
            " WHERE installation_id = ? AND account_id = ?",
            (subject["display_name"], 1 if subject["sponsor"] else 0,
             subject["installation_id"], subject["account_id"]),
        )
        changed = True
    if changed:
        await db.commit()
    return {
        "id": row["user_id"],
        "username": row["username"],
        "account_id": subject["account_id"],
        "display_name": subject["display_name"],
        "sponsor": subject["sponsor"],
    }


async def resolve_subject_user(db, subject: dict) -> dict:
    """按 (installationId, accountId) 解析或创建内部用户，同一事务内完成。

    不同安装的同名账号绝不合并；用户名只是内部标识（onetap:<accountId截断>，
    撞名加序号）。首次并发请求会撞 UNIQUE：插入事务整体回滚后回读映射行复用，
    绝不产生双份用户。
    """
    installation_id = subject["installation_id"]
    account_id = subject["account_id"]
    base = "onetap:" + account_id[:24]
    for attempt in range(50):
        row = await _find_mapping(db, installation_id, account_id)
        if row is not None:
            return await _refresh_mapping(db, row, subject)
        username = base if attempt == 0 else f"{base}-{attempt + 1}"
        try:
            cur = await db.execute(
                "INSERT INTO users (username, nickname, password_hash, is_admin)"
                " VALUES (?, ?, ?, 0)",
                (username, subject["display_name"], _unusable_password()),
            )
            user_id = cur.lastrowid
            await db.execute(
                "INSERT INTO onetap_subjects"
                " (installation_id, account_id, user_id, display_name, sponsor)"
                " VALUES (?, ?, ?, ?, ?)",
                (installation_id, account_id, user_id,
                 subject["display_name"], 1 if subject["sponsor"] else 0),
            )
            await db.commit()
        except sqlite3.IntegrityError:
            # 并发首插或用户名撞名：先回读映射确认是不是同一主体已建好
            await db.rollback()
            row = await _find_mapping(db, installation_id, account_id)
            if row is not None:
                return await _refresh_mapping(db, row, subject)
            continue  # 用户名被别的主体占用，加序号重试
        return {
            "id": user_id,
            "username": username,
            "account_id": account_id,
            "display_name": subject["display_name"],
            "sponsor": subject["sponsor"],
        }
    raise _error("SERVICE_UNAVAILABLE", "账号映射创建失败", 503)


async def get_onetap_context(request: Request, db=Depends(get_onetap_db)) -> dict:
    """网关请求上下文：先验服务密钥，再解析主体，最后映射内部用户。"""
    _check_service_key(request)
    raw = request.headers.get(SUBJECT_HEADER)
    if not raw:
        raise _error("REQUEST_INVALID", "缺少外部主体", 400)
    subject = _parse_subject(raw)
    user = await resolve_subject_user(db, subject)
    return {"subject": subject, "user": user}


# ===== 谱库元数据（一律用服务端元数据，不信任客户端） =====


def content_revision() -> str:
    """谱库内容摘要：data/charts/* 与 data/charts-lib/*/meta.json 的
    （相对名, 大小, mtime）排序后 sha256 截 16 位。只用相对名，不泄露文件系统路径。
    """
    rows: list[tuple[str, int, int]] = []
    charts_dir = get_charts_dir()
    if charts_dir.is_dir():
        for entry in charts_dir.iterdir():
            if entry.is_file():
                st = entry.stat()
                rows.append((entry.name, st.st_size, st.st_mtime_ns))
    lib_dir = get_charts_lib_dir()
    if lib_dir.is_dir():
        for song_dir in lib_dir.iterdir():
            meta_file = song_dir / "meta.json"
            if song_dir.is_dir() and meta_file.is_file():
                st = meta_file.stat()
                rows.append((f"{song_dir.name}/meta.json", st.st_size, st.st_mtime_ns))
    rows.sort()
    digest = hashlib.sha256()
    for name, size, mtime_ns in rows:
        digest.update(f"{name}\x00{size}\x00{mtime_ns}\n".encode("utf-8"))
    return digest.hexdigest()[:16]


def _chart_item(entry: dict) -> dict:
    """合并结果 → 集成条目：difficulty=难度显示串，difficulty_level=定数（数值），
    rating=定数同值别名（对齐独立版合并结果的字段名），difficulty_tier=分级。
    """
    level = str(entry.get("level") or "")
    try:
        rating = float(entry.get("rating") or 0)
    except (TypeError, ValueError):
        rating = 0.0
    rating_text = "%g" % rating
    difficulty = f"{level} Lv.{rating_text}" if level and rating > 0 else level
    # cover 是内容通道标识 <songID>.cover.png（模块内按需下载，与谱面包同一条通道），
    # 手工包没有独立曲绘为 None；song_id/composer/illustrator 供目录分组与展示。
    song_id = str(entry.get("song_id") or "")
    has_cover = bool(entry.get("cover")) and not song_id.startswith("file:")
    return {
        "chart_id": entry["chart_id"],
        "song_id": song_id,
        "song_name": entry["song_name"],
        "composer": entry.get("composer", ""),
        "illustrator": entry.get("illustrator", ""),
        "difficulty": difficulty,
        "difficulty_level": rating,
        "rating": rating,
        "difficulty_tier": level,
        "charter": entry["charter"],
        "chapter": entry["chapter"],
        "chapter_order": entry["chapter_order"],
        "valid": entry["valid"],
        "error": entry["error"],
        "contentId": entry["name"],
        "contentBytes": entry["size"],
        "cover": f"{song_id}.cover.png" if has_cover else None,
        "cover_version": entry.get("cover_version", ""),
    }


_registered_cache: tuple[str, dict[str, dict]] | None = None


def registered_charts() -> dict[str, dict]:
    """chart_id → 服务端元数据索引（按内容修订缓存重建）。

    只含已登记（服务端谱库/手工包）谱面；本地导入的未登记谱面不在其中，
    其自报元数据与登记元数据分开保存，互不覆盖。
    """
    global _registered_cache
    revision = content_revision()
    if _registered_cache is None or _registered_cache[0] != revision:
        index = {}
        for entry in collect_chart_entries():
            item = _chart_item(entry)
            index[item["chart_id"]] = item
        _registered_cache = (revision, index)
    return _registered_cache[1]


def _paging(params) -> tuple[int, int]:
    try:
        page = int(params.get("page", "1") or "1")
        size = int(params.get("pageSize", "50") or "50")
    except (TypeError, ValueError):
        raise _error("REQUEST_INVALID", "分页参数无效", 400)
    if not (1 <= page <= 200 and 1 <= size <= 200):
        raise _error("REQUEST_INVALID", "分页参数无效", 400)
    return page, size


async def _subject_display_rows(db, user_ids: set[int]) -> dict[int, dict]:
    """批量取榜单行的 accountId/displayName/sponsor——一次查询补齐整页，
    不逐行发请求；值是映射行上的缓存，宿主网关展示时还会按 accountId 批量刷新。
    """
    if not user_ids:
        return {}
    cur = await db.execute(
        "SELECT s.user_id, s.account_id, s.display_name, s.sponsor, u.username"
        " FROM onetap_subjects s JOIN users u ON u.id = s.user_id"
        f" WHERE s.user_id IN ({','.join('?' * len(user_ids))})",
        tuple(sorted(user_ids)),
    )
    out: dict[int, dict] = {}
    for row in await cur.fetchall():
        out[row["user_id"]] = {
            "accountId": row["account_id"],
            "displayName": row["display_name"] or row["username"],
            "sponsor": bool(row["sponsor"]),
        }
    return out


# ===== JSON 端点 =====


@router.get("/status")
async def service_status(_=Depends(verify_service_key)):
    """协议版本 + 谱库内容摘要。唯一允许无主体的端点（宿主查可用性时用）。"""
    return {"protocol": PROTOCOL, "contentRevision": content_revision()}


@router.get("/profile")
async def profile(ctx=Depends(get_onetap_context), db=Depends(get_onetap_db)):
    stats = await _user_rks_rows(db, ctx["user"]["id"])
    row = stats.get(ctx["user"]["id"])
    return {
        "displayName": ctx["subject"]["display_name"],
        "sponsor": ctx["subject"]["sponsor"],
        "stats": {
            "rks": round(row["rks"], 4) if row else 0.0,
            # 计入 RKS 的曲目数（最佳 30 窗口内，不足 30 为实际张数）
            "bestCount": row["plays"] if row else 0,
        },
    }


@router.get("/charts")
async def list_charts(request: Request, ctx=Depends(get_onetap_context)):
    """分页谱库：条目字段对齐独立版合并结果，附 contentId/contentBytes。

    contentBytes 对手工包是精确文件大小；对虚拟 <songID>.<LEVEL>.pez 是成员大小
    之和的估算——列目录不重新打包整个谱库，真实打包大小以下载时 Content-Length
    为准（宿主进度条按该长度走）。
    """
    page, size = _paging(request.query_params)
    chapter = request.query_params.get("chapter", "") or ""
    query = request.query_params.get("query", "") or ""
    if len(chapter) > 64 or len(query) > 64:
        raise _error("REQUEST_INVALID", "筛选参数无效", 400)

    entries = collect_chart_entries()
    if chapter:
        # 章节筛选接受章节名或章节 id（前端两种都可能出现）
        names = {chapter}
        for c in _load_chapter_index():
            if c.get("id") == chapter:
                names.add(c.get("name", ""))
        entries = [e for e in entries if e["chapter"] in names]
    if query:
        needle = query.casefold()
        entries = [e for e in entries if needle in e["song_name"].casefold()]
    # 稳定排序：分页必须在两次请求之间可重复，不能依赖文件系统枚举顺序
    entries.sort(key=lambda e: (e["chapter_order"], e["song_name"], e["name"]))
    total = len(entries)
    window = entries[(page - 1) * size: page * size]
    return {
        "items": [_chart_item(e) for e in window],
        "chapters": _load_chapter_index(),
        "total": total,
        "page": page,
        "pageSize": size,
    }


@router.get("/me")
async def me(ctx=Depends(get_onetap_context), db=Depends(get_onetap_db)):
    return await load_me_records(db, ctx["user"]["id"])


def _parse_record_body(body) -> dict:
    """成绩形状与数值范围校验（与网关侧形状检查同口径）。

    run_at 只作展示：Pi 时钟不可信，绝不因时间戳“不合理”拒绝成绩。
    """
    allowed = {"chartId", "songName", "difficulty", "rating", "score", "acc", "isFc", "maxAcc", "runAt"}
    if not isinstance(body, dict) or not set(body) <= allowed:
        raise _error("REQUEST_INVALID", "成绩内容无效", 400)
    chart_id = body.get("chartId")
    if not isinstance(chart_id, str) or not CHART_ID_RE.fullmatch(chart_id):
        raise _error("REQUEST_INVALID", "成绩内容无效", 400)
    song_name = body.get("songName", "")
    difficulty = body.get("difficulty", "")
    if not isinstance(song_name, str) or len(song_name) > 120:
        raise _error("REQUEST_INVALID", "成绩内容无效", 400)
    if not isinstance(difficulty, str) or len(difficulty) > 20:
        raise _error("REQUEST_INVALID", "成绩内容无效", 400)
    numbers: dict[str, float] = {}
    for key in ("rating", "score", "acc", "maxAcc"):
        value = body.get(key)
        # value == value 顺带挡掉 NaN
        if not (type(value) in (int, float) and value == value):
            raise _error("REQUEST_INVALID", "成绩数值无效", 400)
        numbers[key] = value
    is_fc_raw = body.get("isFc")
    if type(is_fc_raw) is bool:
        is_fc = is_fc_raw
    elif type(is_fc_raw) is int and is_fc_raw in (0, 1):
        is_fc = bool(is_fc_raw)
    else:
        raise _error("REQUEST_INVALID", "成绩数值无效", 400)
    if not (0 <= numbers["score"] <= 2_000_000 and 0 <= numbers["acc"] <= 100
            and 0 <= numbers["maxAcc"] <= 100 and 0 <= numbers["rating"] <= 20):
        raise _error("REQUEST_INVALID", "成绩数值超出范围", 400)
    score = numbers["score"]
    if type(score) is float:
        if score != int(score):
            raise _error("REQUEST_INVALID", "成绩数值无效", 400)
        score = int(score)
    run_at = body.get("runAt")
    if run_at is not None and not (isinstance(run_at, str) and len(run_at) <= 40):
        raise _error("REQUEST_INVALID", "成绩时间无效", 400)
    return {
        "chart_id": chart_id,
        "song_name": song_name,
        "difficulty": difficulty,
        "rating": float(numbers["rating"]),
        "score": score,
        "acc": float(numbers["acc"]),
        "is_fc": is_fc,
        "max_acc": float(numbers["maxAcc"]),
        "run_at": run_at,
    }


@router.post("/records")
async def submit_record(request: Request, ctx=Depends(get_onetap_context), db=Depends(get_onetap_db)):
    """成绩合并：规则与独立版 /api/game/pt/records 完全一致（同一 merge_pt_record）。

    响应 best 是合并后库中行的快照，同一成绩重发结果不变（幂等补传）。
    """
    try:
        body = await request.json()
    except ValueError:
        raise _error("REQUEST_INVALID", "成绩内容无效", 400)
    record = _parse_record_body(body)
    registered = registered_charts().get(record["chart_id"])
    if registered:
        # 已登记谱面：名称/难度/定数一律服务端元数据，客户端自报值不能改官方定数影响 RKS。
        record["song_name"] = registered["song_name"]
        record["difficulty"] = registered["difficulty_tier"] or registered["difficulty"]
        record["rating"] = float(registered["rating"])
    result = await merge_pt_record(db, ctx["user"]["id"], **record)
    return {"accepted": True, "best": result["record"]}


@router.get("/chart-leaderboard")
async def chart_leaderboard(request: Request, ctx=Depends(get_onetap_context), db=Depends(get_onetap_db)):
    """单谱榜：与独立版同形状（entries + me，1/2/2/4 并列名次、Top10 截断处并列全显），
    行内附加 accountId/displayName/sponsor 供宿主标识玩家。
    """
    chart_id = request.query_params.get("chartId", "")
    if not isinstance(chart_id, str) or not CHART_ID_RE.fullmatch(chart_id):
        raise _error("REQUEST_INVALID", "谱面标识无效", 400)
    cur = await db.execute(
        "SELECT user_id, score, acc, is_fc, run_at FROM pt_best_records WHERE chart_id = ?",
        (chart_id,),
    )
    ranked = rank_chart_rows([dict(r) for r in await cur.fetchall()])
    top, me_row = select_top_and_me(ranked, ctx["user"]["id"])

    involved = {r["user_id"] for r in top} | ({me_row["user_id"]} if me_row else set())
    subjects = await _subject_display_rows(db, involved)
    stats = await _user_rks_rows(db, only=involved)

    def fmt(row: dict) -> dict:
        subject = subjects.get(row["user_id"], {})
        display = subject.get("displayName", f"user{row['user_id']}")
        return {
            "rank": row["rank"],
            "user_id": row["user_id"],
            "name": display,
            "accountId": subject.get("accountId", ""),
            "displayName": display,
            "sponsor": subject.get("sponsor", False),
            "score": row["score"],
            "acc": row["acc"],
            "is_fc": bool(row["is_fc"]),
            "run_at": row["run_at"],
            "rks": round(stats[row["user_id"]]["rks"], 4) if row["user_id"] in stats else 0.0,
            "is_me": row["user_id"] == ctx["user"]["id"],
        }

    return {
        "chart_id": chart_id,
        "entries": [fmt(r) for r in top],
        "me": fmt(me_row) if me_row else None,
    }


@router.get("/leaderboard")
async def leaderboard(request: Request, ctx=Depends(get_onetap_context), db=Depends(get_onetap_db)):
    """全服排行：RKS 降序分页；同行含 accountId/displayName/sponsor。"""
    page, size = _paging(request.query_params)
    stats = await _user_rks_rows(db)
    entries = [
        {"user_id": uid, "rks": round(s["rks"], 4), "plays": s["plays"]}
        for uid, s in stats.items()
    ]
    entries.sort(key=lambda e: (-e["rks"], e["user_id"]))
    prev_key = None
    rank = 0
    for i, entry in enumerate(entries):
        if entry["rks"] != prev_key:
            rank = i + 1
            prev_key = entry["rks"]
        entry["rank"] = rank
    my_row = next((e for e in entries if e["user_id"] == ctx["user"]["id"]), None)

    window = entries[(page - 1) * size: page * size]
    subjects = await _subject_display_rows(db, {e["user_id"] for e in window})
    items = []
    for entry in window:
        subject = subjects.get(entry["user_id"], {})
        display = subject.get("displayName", f"user{entry['user_id']}")
        items.append({
            "rank": entry["rank"],
            "user_id": entry["user_id"],
            "name": display,
            "accountId": subject.get("accountId", ""),
            "displayName": display,
            "sponsor": subject.get("sponsor", False),
            "rks": entry["rks"],
            "plays": entry["plays"],
            "is_me": entry["user_id"] == ctx["user"]["id"],
        })
    return {
        "items": items,
        "total": len(entries),
        "page": page,
        "pageSize": size,
        "myRank": my_row["rank"] if my_row else None,
        "myRks": my_row["rks"] if my_row else 0.0,
    }


# ===== 二进制内容：Range / 流式 / 摘要 =====


_content_sha_cache: dict[str, tuple[int, int, str]] = {}


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _cached_file_sha256(path: Path) -> str:
    """手工包摘要按 (mtime_ns, size) 缓存：同一文件反复下载不重算整包。"""
    stat = path.stat()
    key = str(path)
    cached = _content_sha_cache.get(key)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2]
    sha = _file_sha256(path)
    _content_sha_cache[key] = (stat.st_mtime_ns, stat.st_size, sha)
    return sha


def _parse_single_range(header: str, size: int) -> tuple[int, int, bool] | None:
    """单段 Range（bytes=a-b / bytes=a-）→ (start, end, partial)。

    不支持的语法（多段、后缀 bytes=-b、乱写）按 RFC 忽略并回整包；
    越界/倒序返回 None（调用方回 416）。
    """
    matched = RANGE_RE.fullmatch(header.strip())
    if matched is None:
        return 0, size - 1, False
    start = int(matched.group(1))
    end = int(matched.group(2)) if matched.group(2) else size - 1
    if size == 0 or start >= size or start > end:
        return None
    return start, min(end, size - 1), True


async def _iter_file(path: Path, start: int, length: int, cleanup: Path | None = None):
    """分块（≥64KiB）流式发送；cleanup 是发送完毕后删除的临时包（虚拟 pez）。"""
    try:
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
    finally:
        if cleanup is not None:
            try:
                cleanup.unlink()
            except OSError:
                pass


def _discard(path: Path | None) -> None:
    if path is not None:
        try:
            path.unlink()
        except OSError:
            pass


@router.get("/content/{content_id}")
async def get_content(content_id: str, request: Request, _=Depends(get_onetap_context)):
    """二进制内容下载：Accept-Ranges + 单段 Range → 200/206/416。

    虚拟 <songID>.<LEVEL>.pez 先打包到临时文件（顺带得到真实大小与整包 sha256），
    发完即删；手工包直接分块读文件，整包不进内存。X-Content-Sha256 是完整资源的
    摘要（不是所请求分段的），宿主据此校验落盘内容。
    """
    if not CONTENT_ID_RE.fullmatch(content_id) or ".." in content_id:
        raise _error("REQUEST_INVALID", "内容标识无效", 400)
    source, payload = resolve_chart_package(content_id)
    if source == "missing":
        raise _error("NOT_FOUND", "内容不存在", 404)

    cleanup: Path | None = None
    try:
        if source == "file":
            path = payload
            size = path.stat().st_size
            sha = _cached_file_sha256(path)
        else:
            song_dir, meta, level = payload
            fd, tmp_name = tempfile.mkstemp(prefix="onetap-pez-", suffix=".pez")
            os.close(fd)
            path = Path(tmp_name)
            cleanup = path
            with open(path, "wb") as out:
                if not _write_lib_pez(song_dir, meta, level, out):
                    raise _error("NOT_FOUND", "内容不存在", 404)
            size = path.stat().st_size
            sha = _file_sha256(path)

        ranged = _parse_single_range(request.headers.get("range", ""), size)
        if ranged is None:
            _discard(cleanup)
            return JSONResponse(
                {"error": {"code": "REQUEST_INVALID", "message": "Range 无法满足"}},
                status_code=416,
                headers={"Content-Range": f"bytes */{size}"},
            )
        start, end, partial = ranged
        length = max(end - start + 1, 0)
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(length),
            "X-Content-Sha256": sha,
        }
        if partial:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return StreamingResponse(
            _iter_file(path, start, length, cleanup),
            status_code=206 if partial else 200,
            headers=headers,
        )
    except BaseException:
        # 出错或没进入流式阶段时临时文件立即清理；流式阶段由生成器 finally 清理
        _discard(cleanup)
        raise


# ===== 应用装配：只挂 /int/v1/* 与 /api/health，其余路径 404 JSON =====


async def _http_error_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        code = str(detail.get("code") or "REQUEST_INVALID")
        message = str(detail.get("message") or "")
    else:
        code = _STATUS_CODES.get(exc.status_code) or (
            "SERVICE_UNAVAILABLE" if exc.status_code >= 500 else "REQUEST_INVALID"
        )
        message = str(detail or "")
    return JSONResponse(
        {"error": {"code": code, "message": message}}, status_code=exc.status_code
    )


async def _validation_error_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        {"error": {"code": "REQUEST_INVALID", "message": "请求参数无效"}},
        status_code=400,
    )


async def _unhandled_error_handler(request: Request, exc: Exception):
    # 服务故障必须可识别：报 SERVICE_UNAVAILABLE，绝不伪装成未登录
    _log.exception("集成模式未处理异常")
    return JSONResponse(
        {"error": {"code": "SERVICE_UNAVAILABLE", "message": "服务内部错误"}},
        status_code=500,
    )


@asynccontextmanager
async def _lifespan(app: FastAPI):
    await init_onetap_db()
    _log.info(
        "OneTap 集成模式启动：只挂 /int/v1/* 与 /api/health（独立注册/登录/刷新与 SPA 托管全部关闭）"
    )
    yield


def create_integration_app() -> FastAPI:
    app = FastAPI(title="PhiTogether OneTap Integration", lifespan=_lifespan)
    app.include_router(router)

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    # 兜底必须注册在具体路由之后：/api/auth/*、SPA 静态等一律 404 JSON，
    # 不给集成模式留任何独立模式的入口。
    @app.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    async def _unmatched(path: str):
        raise _error("NOT_FOUND", "该路径在集成模式下不存在", 404)

    app.add_exception_handler(StarletteHTTPException, _http_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(Exception, _unhandled_error_handler)
    return app
