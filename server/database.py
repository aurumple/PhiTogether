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


async def init_db() -> None:
    Path(get_settings().data_dir).mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(get_settings().db_path) as db:
        await db.executescript(SCHEMA)
        await _migrate(db)
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
