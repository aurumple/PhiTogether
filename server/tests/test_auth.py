"""Register / login / refresh / me flows."""
from conftest import register_and_login


async def test_register_first_user_becomes_admin(client):
    resp = await client.post(
        "/api/auth/register",
        json={"username": "boss", "password": "secret6", "confirm_password": "secret6"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["is_admin"] is True
    assert body["nickname"] == "boss"  # defaults to username

    resp = await client.post(
        "/api/auth/register",
        json={"username": "player", "password": "secret6", "confirm_password": "secret6"},
    )
    assert resp.status_code == 201
    assert resp.json()["is_admin"] is False


async def test_register_validation(client):
    resp = await client.post(
        "/api/auth/register",
        json={"username": "player", "password": "secret6", "confirm_password": "other66"},
    )
    assert resp.status_code == 422

    resp = await client.post(
        "/api/auth/register",
        json={"username": "x", "password": "secret6", "confirm_password": "secret6"},
    )
    assert resp.status_code == 422

    for _ in range(2):
        resp = await client.post(
            "/api/auth/register",
            json={"username": "dup", "password": "secret6", "confirm_password": "secret6"},
        )
    assert resp.status_code == 409


async def test_login_and_me(client):
    await register_and_login(client)
    resp = await client.post(
        "/api/auth/login", json={"username": "player", "password": "wrong11"}
    )
    assert resp.status_code == 401

    _, headers = await register_and_login(client, username="other")
    resp = await client.get("/api/auth/me", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["username"] == "other"
    assert body["nickname"] == "OTHER"


async def test_endpoints_require_auth(client):
    for path in ("/api/auth/me", "/api/game/charts", "/api/game/pt/me", "/api/game/pt/leaderboard"):
        resp = await client.get(path)
        assert resp.status_code == 401, path


async def test_new_login_invalidates_old_tokens(client):
    old_tokens, _ = await register_and_login(client)
    resp = await client.post("/api/auth/login", json={"username": "player", "password": "secret6"})
    assert resp.status_code == 200
    new_tokens = resp.json()
    new_headers = {"Authorization": f"Bearer {new_tokens['access_token']}"}

    resp = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {old_tokens['access_token']}"})
    assert resp.status_code == 401

    resp = await client.get("/api/auth/me", headers=new_headers)
    assert resp.status_code == 200
    assert new_tokens["access_token"] != old_tokens["access_token"]


async def test_refresh_issues_working_access_token(client):
    tokens, _ = await register_and_login(client)
    resp = await client.post("/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert resp.status_code == 200
    refreshed = resp.json()
    resp = await client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {refreshed['access_token']}"}
    )
    assert resp.status_code == 200

    resp = await client.post("/api/auth/refresh", json={"refresh_token": "garbage"})
    assert resp.status_code == 401

    # Access tokens must not be usable as refresh tokens.
    resp = await client.post("/api/auth/refresh", json={"refresh_token": tokens["access_token"]})
    assert resp.status_code == 401
