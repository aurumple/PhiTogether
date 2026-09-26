"""Shared fixtures: isolate every test in its own temp data directory.

PT_DATA_DIR is redirected per test so runs never touch the real ``server/data/``.
"""
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PT_JWT_SECRET", "test-secret-0123456789-0123456789-abcdef")
    import config
    config._settings_singleton = None
    # Caches are module-global and keyed by filename/relative path; drop
    # cross-test state so ids from one temp data dir never leak into another.
    from routers import game as game_module
    game_module._chart_validation_cache.clear()
    game_module._lib_chart_id_cache.clear()
    game_module._lib_chart_ids_loaded = False
    yield tmp_path
    config._settings_singleton = None
    game_module._chart_validation_cache.clear()
    game_module._lib_chart_id_cache.clear()
    game_module._lib_chart_ids_loaded = False


@pytest_asyncio.fixture
async def client():
    from database import init_db
    from main import create_app

    await init_db()
    # 每个测试按当前环境重新装配 app：集成/独立两种模式各自显式选择，
    # 不复用 import 时的模块级实例（避免测试间模式串扰）。
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as ac:
        yield ac


async def register_and_login(client, username="player", password="secret6"):
    """Full registration + login helper; returns (user_json, auth_headers)."""
    resp = await client.post(
        "/api/auth/register",
        json={
            "username": username,
            "password": password,
            "confirm_password": password,
            "nickname": username.upper(),
        },
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert resp.status_code == 200, resp.text
    tokens = resp.json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    return tokens, headers
