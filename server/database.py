"""SQLite persistence: users and PhiTogether best-score records."""
import logging
from pathlib import Path

import aiosqlite

from config import get_settings

_log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Best score per (user, chart). score/acc/is_fc describe one run: the best run,
-- lexicographically (score, acc, is_fc) — accuracy ties break by FC. best_acc is
-- the highest accuracy ever seen on the chart and drives rks
-- (rks = rating * (best_acc/100)^2 per chart; player rks = mean of the top-30
-- chart_rks, see PT_BEST_LIMIT in routers/game.py).
CREATE TABLE IF NOT EXISTS pt_best_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    chart_id TEXT NOT NULL,
    song_name TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT '',
    rating REAL NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    acc REAL NOT NULL DEFAULT 0,
    is_fc INTEGER NOT NULL DEFAULT 0,
    best_acc REAL NOT NULL DEFAULT 0,
    run_at TEXT,
    chart_rks REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, chart_id)
);
CREATE INDEX IF NOT EXISTS idx_pt_best_user_rks ON pt_best_records(user_id, chart_rks DESC);
CREATE INDEX IF NOT EXISTS idx_pt_best_chart ON pt_best_records(chart_id);

-- OneTap 集成模式的外部主体映射：一个 (installation_id, account_id) 对应一个内部
-- users 行（user_id 全局唯一）。身份只认这个映射——改名只刷新 nickname/展示缓存，
-- 不同安装的同名账号绝不合并。display_name / sponsor 是映射行上的展示缓存，每次
-- 请求随主体刷新；宿主网关展示榜单时还会按 accountId 批量刷新，所以这里只需要
-- “最近一次见到的值”，不负责自行保鲜。
CREATE TABLE IF NOT EXISTS onetap_subjects (
    installation_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    display_name TEXT NOT NULL DEFAULT '',
    sponsor INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (installation_id, account_id)
);
"""


async def _migrate(db) -> None:
    """Add columns introduced after the first release to existing databases."""
    cur = await db.execute("PRAGMA table_info(pt_best_records)")
    cols = {row[1] for row in await cur.fetchall()}
    if "best_acc" not in cols:
        await db.execute(
            "ALTER TABLE pt_best_records ADD COLUMN best_acc REAL NOT NULL DEFAULT 0"
        )
    if "run_at" not in cols:
        await db.execute("ALTER TABLE pt_best_records ADD COLUMN run_at TEXT")
    # Old rows stored one merged record whose acc was already the best accuracy.
    await db.execute("UPDATE pt_best_records SET best_acc = acc WHERE best_acc = 0")
    await db.execute(
        "UPDATE pt_best_records SET run_at = updated_at WHERE run_at IS NULL"
    )
    # onetap_subjects 的展示缓存列：CREATE IF NOT EXISTS 不会给已存在的旧表补列，
    # 所以增量迁移在这里兜底（表不存在时 PRAGMA 返回空，直接跳过）。
    cur = await db.execute("PRAGMA table_info(onetap_subjects)")
    cols = {row[1] for row in await cur.fetchall()}
    if cols and "display_name" not in cols:
        await db.execute(
            "ALTER TABLE onetap_subjects ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"
        )
    if cols and "sponsor" not in cols:
        await db.execute(
            "ALTER TABLE onetap_subjects ADD COLUMN sponsor INTEGER NOT NULL DEFAULT 0"
        )


async def init_db() -> None:
    Path(get_settings().data_dir).mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(get_settings().db_path) as db:
        await db.executescript(SCHEMA)
        await _migrate(db)
        await db.commit()


async def init_onetap_db() -> None:
    """集成模式专用库：独立文件，同一套 users/pt_best_records/onetap_subjects schema。

    与独立版 phitogether.db 严格分开——模块账号、成绩绝不读写独立版数据。
    """
    db_path = get_settings().onetap_db_path
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(SCHEMA)
        await _migrate(db)
        await db.commit()


async def _open_db(path: str):
    db = await aiosqlite.connect(path)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys=ON")
    # Concurrent writers wait instead of failing immediately with SQLITE_BUSY.
    await db.execute("PRAGMA busy_timeout=5000")
    return db


async def get_db():
    db = await _open_db(get_settings().db_path)
    try:
        yield db
    finally:
        await db.close()


async def get_onetap_db():
    """集成模式请求连接：只连 onetap 库，不碰独立版 phitogether.db。"""
    db = await _open_db(get_settings().onetap_db_path)
    try:
        yield db
    finally:
        await db.close()


async def get_first_user_count(db) -> int:
    cursor = await db.execute("SELECT COUNT(*) FROM users")
    row = await cursor.fetchone()
    return row[0]
