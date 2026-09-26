"""OneTap 集成模式：密钥门槛、主体映射并发、成绩幂等合并、谱库分页、内容 Range。"""
import asyncio
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import aiosqlite
import pytest
from httpx import ASGITransport, AsyncClient

SERVICE_KEY = "test-service-key-0123456789abcdef"  # 36 chars, >= 32


def subject_headers(
    installation="inst-1", account="acc-1", name="Player One", sponsor=False, key=SERVICE_KEY
):
    return {
        "X-OT-Service-Key": key,
        "X-OT-Subject": json.dumps(
            {
                "installationId": installation,
                "accountId": account,
                "displayName": name,
                "sponsor": sponsor,
            },
            ensure_ascii=False,
        ),
    }


async def query_all(db_path, sql, params=()):
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(sql, params)
        return [dict(r) for r in await cur.fetchall()]


@pytest.fixture
async def iclient(tmp_path, monkeypatch):
    monkeypatch.setenv("PT_ONETAP_INTEGRATION", "1")
    monkeypatch.setenv("PT_ONETAP_SERVICE_KEY", SERVICE_KEY)
    monkeypatch.setenv("PT_ONETAP_DB", str(tmp_path / "onetap.db"))
    import config
    from routers import game as game_module
    from routers import integration as int_module

    config._settings_singleton = None
    game_module._chart_validation_cache.clear()
    game_module._lib_chart_id_cache.clear()
    game_module._lib_chart_ids_loaded = False
    int_module._content_sha_cache.clear()
    int_module._registered_cache = None

    from database import init_onetap_db
    from main import create_app

    await init_onetap_db()
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as ac:
        yield ac

    config._settings_singleton = None
    game_module._chart_validation_cache.clear()
    game_module._lib_chart_id_cache.clear()
    game_module._lib_chart_ids_loaded = False
    int_module._content_sha_cache.clear()
    int_module._registered_cache = None


# ===== 1. 密钥门槛 + 两种模式互斥 =====


async def test_service_key_gate_and_mode_isolation(iclient, tmp_path, monkeypatch):
    # 缺密钥/错密钥一律 403 ACCESS_DENIED；密钥不通过前主体连解析都不发生
    resp = await iclient.get("/int/v1/profile")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "ACCESS_DENIED"

    bad = subject_headers(key="wrong-key-0123456789abcdef0123456789")
    bad["X-OT-Subject"] = "{not json"
    resp = await iclient.get("/int/v1/profile", headers=bad)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "ACCESS_DENIED"

    # 密钥通过但主体缺失/形状错 → 400 REQUEST_INVALID（不是“未登录”）
    resp = await iclient.get("/int/v1/profile", headers={"X-OT-Service-Key": SERVICE_KEY})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "REQUEST_INVALID"
    for subject in (
        '{"installationId":""}',
        '{"installationId":"a","accountId":"b","displayName":"c","sponsor":"yes"}',
        '{"installationId":"a","accountId":"b"}',
    ):
        resp = await iclient.get(
            "/int/v1/profile",
            headers={"X-OT-Service-Key": SERVICE_KEY, "X-OT-Subject": subject},
        )
        assert resp.status_code == 400, subject

    # status 是唯一允许无主体的端点；contentRevision 为 16 位 hex
    resp = await iclient.get("/int/v1/status", headers={"X-OT-Service-Key": SERVICE_KEY})
    assert resp.status_code == 200
    body = resp.json()
    assert body["protocol"] == 1
    assert re.fullmatch(r"[0-9a-f]{16}", body["contentRevision"])

    # 集成模式下独立模式的入口（auth/游戏 API/SPA）一律 404 JSON
    for path in ("/api/auth/login", "/api/auth/register", "/api/game/charts", "/", "/index.html"):
        resp = await iclient.get(path, headers=subject_headers())
        assert resp.status_code == 404, path
        assert resp.json()["error"]["code"] == "NOT_FOUND"

    # 独立模式不挂 /int/v1，且 /api/health 照常
    monkeypatch.delenv("PT_ONETAP_INTEGRATION", raising=False)
    monkeypatch.setenv("PT_JWT_SECRET", "test-secret-0123456789-0123456789-abcdef")
    import config
    from main import create_app

    config._settings_singleton = None
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as ac:
        assert (
            await ac.get("/int/v1/status", headers={"X-OT-Service-Key": SERVICE_KEY})
        ).status_code == 404
        assert (await ac.get("/api/health")).status_code == 200

    # 服务密钥缺失/过短 → 启动直接失败
    monkeypatch.setenv("PT_ONETAP_INTEGRATION", "1")
    monkeypatch.setenv("PT_ONETAP_SERVICE_KEY", "short")
    config._settings_singleton = None
    with pytest.raises(RuntimeError):
        create_app()
    monkeypatch.delenv("PT_ONETAP_SERVICE_KEY")
    config._settings_singleton = None
    with pytest.raises(RuntimeError):
        create_app()
    config._settings_singleton = None


# ===== 2. 主体映射：并发首插、改名不改身份、不同安装不合并 =====


async def test_subject_mapping_concurrent_first_request(iclient, tmp_path):
    db_path = tmp_path / "onetap.db"

    # 同一主体并发首次请求 → 内部用户/映射都只有一份
    results = await asyncio.gather(
        *[iclient.get("/int/v1/profile", headers=subject_headers(name="Alice")) for _ in range(8)]
    )
    assert all(r.status_code == 200 for r in results)
    users = await query_all(db_path, "SELECT username, nickname, is_admin, password_hash FROM users")
    assert len(users) == 1
    assert users[0]["username"] == "onetap:acc-1"
    assert users[0]["nickname"] == "Alice"
    assert users[0]["is_admin"] == 0
    assert not users[0]["password_hash"].startswith("pbkdf2")  # 本地密码登录不可用
    maps = await query_all(db_path, "SELECT installation_id, account_id, user_id FROM onetap_subjects")
    assert len(maps) == 1 and maps[0]["installation_id"] == "inst-1"

    # 改名只刷新显示名，不改变身份（user_id 不变）
    resp = await iclient.get("/int/v1/profile", headers=subject_headers(name="Alice Renamed"))
    assert resp.json()["displayName"] == "Alice Renamed"
    users = await query_all(db_path, "SELECT id, nickname FROM users")
    assert len(users) == 1 and users[0]["nickname"] == "Alice Renamed"

    # 同一 accountId 换 installation：绝不合并（用户名撞名走加序号分支）
    resp = await iclient.get("/int/v1/profile", headers=subject_headers(installation="inst-2"))
    assert resp.status_code == 200
    users = await query_all(db_path, "SELECT username FROM users ORDER BY id")
    assert {u["username"] for u in users} == {"onetap:acc-1", "onetap:acc-1-2"}

    # sponsor 与显示名缓存在映射行上随请求刷新
    resp = await iclient.get("/int/v1/profile", headers=subject_headers(sponsor=True))
    assert resp.json()["sponsor"] is True
    assert resp.json()["stats"] == {"rks": 0.0, "bestCount": 0}
    rows = await query_all(
        db_path,
        "SELECT installation_id, display_name, sponsor FROM onetap_subjects ORDER BY installation_id",
    )
    assert rows[0]["display_name"] == "Player One" and rows[0]["sponsor"] == 1


# ===== 3. 成绩合并：与独立版同规则、幂等重发 =====


async def test_records_merge_is_idempotent(iclient):
    headers = subject_headers(account="rec-1")
    payload = {
        "chartId": "a" * 32,
        "songName": "Song",
        "difficulty": "IN Lv.16",
        "rating": 16,
        "score": 900000,
        "acc": 95,
        "isFc": 1,
        "maxAcc": 95,
        "runAt": "2026-09-26T10:00:00Z",
    }
    resp = await iclient.post("/int/v1/records", json=payload, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["accepted"] is True
    best = resp.json()["best"]
    assert best["score"] == 900000 and best["acc"] == 95 and best["is_fc"] == 1
    assert best["chart_rks"] == pytest.approx(round(16 * 0.95**2, 4))

    # 同一成绩重发：响应逐字段一致（幂等补传）
    again = await iclient.post("/int/v1/records", json=payload, headers=headers)
    assert again.json() == resp.json()

    # 更高 acc 但更低分：最佳单局不变，max_acc 独立抬高 rks
    worse = dict(payload, score=800000, acc=99, maxAcc=99, isFc=0)
    resp = await iclient.post("/int/v1/records", json=worse, headers=headers)
    best = resp.json()["best"]
    assert best["score"] == 900000 and best["acc"] == 95 and best["is_fc"] == 1
    assert best["best_acc"] == 99
    assert best["chart_rks"] == pytest.approx(round(16 * 0.99**2, 4))

    # profile / me 与合并结果一致（bestCount = 计入 RKS 的曲目数）
    profile = (await iclient.get("/int/v1/profile", headers=headers)).json()
    assert profile["stats"]["bestCount"] == 1
    assert profile["stats"]["rks"] == pytest.approx(round(16 * 0.99**2, 4))
    me = (await iclient.get("/int/v1/me", headers=headers)).json()
    assert me["limit"] == 30
    assert me["rks"] == pytest.approx(profile["stats"]["rks"])
    assert me["records"][0]["chart_id"] == "a" * 32

    # runAt 缺失用服务端时间，绝不因时间戳不合理拒收
    no_time = dict(payload, chartId="b" * 32)
    no_time.pop("runAt")
    resp = await iclient.post("/int/v1/records", json=no_time, headers=headers)
    assert resp.status_code == 200 and resp.json()["best"]["run_at"]

    # 形状/数值范围校验
    for bad in (
        dict(payload, chartId="c" * 32, score=2_000_001),
        dict(payload, chartId="c" * 32, acc=101),
        dict(payload, chartId="c" * 32, maxAcc=-1),
        dict(payload, chartId="c" * 32, rating=21),
        dict(payload, chartId="c" * 32, isFc=2),
        dict(payload, chartId="not-hex"),
        dict(payload, chartId="c" * 32, runAt="x" * 41),
        {"chartId": "d" * 32, "extra": 1},
    ):
        resp = await iclient.post("/int/v1/records", json=bad, headers=headers)
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["code"] == "REQUEST_INVALID"


# ===== 4. 谱库分页与条目字段 =====


async def test_charts_pagination_and_fields(iclient, tmp_path):
    from test_chart_lib import make_lib_song

    make_lib_song(levels=("EZ", "IN"))  # 共享库 2 条
    charts_dir = Path(tmp_path) / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(charts_dir / "Manual.Song.pez", "w") as zf:
        zf.writestr("info.txt", "#\nName: Manual Song\nLevel: HD Lv.12\nComposer: C\nCharter: X")
        zf.writestr("chart.json", json.dumps({"formatVersion": 3, "judgeLineList": []}))
        zf.writestr("song.ogg", b"fake-audio")

    headers = subject_headers()
    resp = await iclient.get("/int/v1/charts?page=1&pageSize=2", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3 and body["page"] == 1 and body["pageSize"] == 2
    assert len(body["items"]) == 2
    names = [c["name"] for c in body["chapters"]]
    assert "单曲精选集" in names and "隐秘" in names and "其他" in names

    ez = body["items"][0]
    assert ez["contentId"] == "Test.Song.EZ.pez"
    assert ez["song_name"] == "Test Song"
    assert ez["difficulty"] == "EZ Lv.12.6"
    assert ez["difficulty_level"] == 12.6  # 定数
    assert ez["rating"] == 12.6
    assert ez["difficulty_tier"] == "EZ"
    assert ez["charter"] == "Tester"
    assert ez["chapter"] == "Chapter 5 霓虹灯牌"
    assert ez["chapter_order"] == 1
    assert ez["valid"] is True and ez["error"] == ""
    assert ez["chart_id"] == hashlib.md5(
        json.dumps({"formatVersion": 3, "judgeLineList": []}).encode("utf-8")
    ).hexdigest()
    # 虚拟 pez 的 contentBytes 是成员大小之和（估算）
    song_dir = Path(tmp_path) / "charts-lib" / "Test.Song"
    assert ez["contentBytes"] == sum(
        (song_dir / f).stat().st_size for f in ("music.ogg", "EZ.json", "illustration.png")
    )

    # 第二页：手工包（chapter_order 999 排最后）
    resp = await iclient.get("/int/v1/charts?page=2&pageSize=2", headers=headers)
    page2 = resp.json()
    assert [c["contentId"] for c in page2["items"]] == ["Manual.Song.pez"]
    manual = page2["items"][0]
    assert manual["difficulty"] == "HD Lv.12"
    assert manual["difficulty_level"] == 12.0
    assert manual["song_name"] == "Manual Song"
    assert manual["contentBytes"] == (charts_dir / "Manual.Song.pez").stat().st_size

    # 章节（名或 id）与搜索过滤
    resp = await iclient.get(
        "/int/v1/charts?chapter=" + "Chapter 5 霓虹灯牌", headers=headers
    )
    assert [c["contentId"] for c in resp.json()["items"]] == [
        "Test.Song.EZ.pez",
        "Test.Song.IN.pez",
    ]
    resp = await iclient.get("/int/v1/charts?query=manual", headers=headers)
    assert [c["contentId"] for c in resp.json()["items"]] == ["Manual.Song.pez"]

    # 分页形状校验 1..200（空值视作缺省，与网关 _page 同口径）
    for bad in ("page=0", "page=201", "pageSize=0", "pageSize=201", "page=abc", "pageSize=1.5"):
        resp = await iclient.get(f"/int/v1/charts?{bad}", headers=headers)
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["code"] == "REQUEST_INVALID"
    resp = await iclient.get("/int/v1/charts?pageSize=", headers=headers)
    assert resp.status_code == 200 and resp.json()["pageSize"] == 50


# ===== 5. 内容下载：Range / 分块 / 整包 sha256 =====


async def test_content_download_range_and_sha256(iclient, tmp_path):
    from test_chart_lib import make_lib_song

    make_lib_song(levels=("EZ",))
    headers = subject_headers()

    full = await iclient.get("/int/v1/content/Test.Song.EZ.pez", headers=headers)
    assert full.status_code == 200
    body = full.content
    assert full.headers["accept-ranges"] == "bytes"
    assert full.headers["content-type"] == "application/octet-stream"
    assert full.headers["x-content-sha256"] == hashlib.sha256(body).hexdigest()
    assert int(full.headers["content-length"]) == len(body)
    assert zipfile.is_zipfile(io.BytesIO(body))

    # 单段 Range：bytes=a-b 与 bytes=a-；X-Content-Sha256 始终是整包摘要
    resp = await iclient.get(
        "/int/v1/content/Test.Song.EZ.pez", headers={**headers, "Range": "bytes=10-19"}
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 10-19/{len(body)}"
    assert int(resp.headers["content-length"]) == 10
    assert resp.content == body[10:20]
    assert resp.headers["x-content-sha256"] == full.headers["x-content-sha256"]

    resp = await iclient.get(
        "/int/v1/content/Test.Song.EZ.pez", headers={**headers, "Range": "bytes=5-"}
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 5-{len(body) - 1}/{len(body)}"
    assert resp.content == body[5:]

    # 越界 Range → 416 REQUEST_INVALID
    resp = await iclient.get(
        "/int/v1/content/Test.Song.EZ.pez",
        headers={**headers, "Range": f"bytes={len(body)}-"},
    )
    assert resp.status_code == 416
    assert resp.json()["error"]["code"] == "REQUEST_INVALID"

    # 手工包同规则（走文件流，不打包）
    charts_dir = Path(tmp_path) / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)
    (charts_dir / "Manual.pez").write_bytes(b"x" * 100)
    resp = await iclient.get("/int/v1/content/Manual.pez", headers={**headers, "Range": "bytes=0-9"})
    assert resp.status_code == 206 and resp.content == b"x" * 10
    assert resp.headers["x-content-sha256"] == hashlib.sha256(b"x" * 100).hexdigest()

    # contentId 白名单 / 路径穿越 / 不存在
    for bad in ("x" * 129, "hello world", ".."):
        resp = await iclient.get(f"/int/v1/content/{bad}", headers=headers)
        assert resp.status_code in (400, 404), bad
        assert resp.json()["error"]["code"] in ("REQUEST_INVALID", "NOT_FOUND")
    resp = await iclient.get("/int/v1/content/Missing.Song.IN.pez", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


# ===== 7. 已登记谱面元数据覆盖 + 非 ASCII contentId =====


async def test_registered_metadata_overrides_client_reported(iclient):
    from test_chart_lib import make_lib_song

    make_lib_song(levels=("EZ",))  # EZ 定数 12.6、曲名 Test Song
    chart_id = hashlib.md5(
        json.dumps({"formatVersion": 3, "judgeLineList": []}).encode("utf-8")
    ).hexdigest()
    headers = subject_headers(account="meta-1")
    spoof = {
        "chartId": chart_id,
        "songName": "Spoofed Name",
        "difficulty": "AT",
        "rating": 20,
        "score": 900000,
        "acc": 95,
        "isFc": 1,
        "maxAcc": 95,
    }
    resp = await iclient.post("/int/v1/records", json=spoof, headers=headers)
    assert resp.status_code == 200
    best = resp.json()["best"]
    # 已登记谱面：名称/难度/定数一律服务端元数据，客户端自报值不能改官方定数影响 RKS
    assert best["rating"] == 12.6
    assert best["song_name"] == "Test Song"
    assert best["difficulty"] == "EZ"
    assert best["chart_rks"] == pytest.approx(round(12.6 * 0.95**2, 4))

    # 未登记（本地导入）chart_id：保留客户端自报元数据，两者分开互不覆盖
    unknown = dict(spoof, chartId="c" * 32, songName="Local Chart", difficulty="IN Lv.14", rating=14)
    resp = await iclient.post("/int/v1/records", json=unknown, headers=headers)
    assert resp.status_code == 200
    best = resp.json()["best"]
    assert best["song_name"] == "Local Chart" and best["rating"] == 14


async def test_content_non_ascii_song_id(iclient):
    from test_chart_lib import make_lib_song

    # 谱库 songID 含非 ASCII（日文歌名）：可列也可下，不因 ASCII 白名单丢内容
    make_lib_song(song_id="かたぎり", levels=("EZ",))
    headers = subject_headers()
    resp = await iclient.get("/int/v1/content/かたぎり.EZ.pez", headers=headers)
    assert resp.status_code == 200
    assert zipfile.is_zipfile(io.BytesIO(resp.content))
    # 父目录引用始终取不到内容：可能被路由规范化挡成 404，也可能到 handler 被 400 拒绝
    resp = await iclient.get("/int/v1/content/..%2F..%2Fsecret.pez", headers=headers)
    assert resp.status_code in (400, 404)
    assert resp.status_code != 200
