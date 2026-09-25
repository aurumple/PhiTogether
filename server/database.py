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

-- Best score per (user, chart). rks = rating * (acc/100)^2 per chart;
-- player rks = mean of the top-30 chart_rks (see PT_BEST_LIMIT in routers/game.py).
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
    chart_rks REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, chart_id)
);
CREATE INDEX IF NOT EXISTS idx_pt_best_user_rks ON pt_best_records(user_id, chart_rks DESC);
"""


async def init_db() -> None:
    Path(get_settings().data_dir).mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(get_settings().db_path) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def get_db():
    db = await aiosqlite.connect(get_settings().db_path)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys=ON")
    # Concurrent writers wait instead of failing immediately with SQLITE_BUSY.
    await db.execute("PRAGMA busy_timeout=5000")
    try:
        yield db
    finally:
        await db.close()


async def get_first_user_count(db) -> int:
    cursor = await db.execute("SELECT COUNT(*) FROM users")
    row = await cursor.fetchone()
    return row[0]
