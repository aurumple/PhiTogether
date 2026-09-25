"""Chart discovery + download endpoints."""
import hashlib
import io
import json
import zipfile

from conftest import register_and_login


def make_chart_package(path, *, with_audio=True, with_chart_json=True, chart=None):
    """Build a minimal .pez-like zip the server validator accepts."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if with_chart_json:
            zf.writestr("chart.json", json.dumps(chart or {"formatVersion": 1}))
        if with_audio:
            zf.writestr("song.mp3", b"fake-audio")
        zf.writestr("illustration.png", b"fake-image")
    path.write_bytes(buf.getvalue())


async def test_list_charts_empty_when_no_dir(client):
    _, headers = await register_and_login(client)
    resp = await client.get("/api/game/charts", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["charts"] == []
    assert isinstance(body["chapters"], list)


async def test_list_charts_with_validation_verdicts(client, tmp_path):
    _, headers = await register_and_login(client)
    from routers.game import get_charts_dir

    charts_dir = get_charts_dir()
    charts_dir.mkdir(parents=True, exist_ok=True)
    make_chart_package(charts_dir / "good.pez")
    make_chart_package(charts_dir / "broken.pez", with_audio=False)
    (charts_dir / "notazip.pez").write_bytes(b"garbage")
    (charts_dir / "notes.txt").write_text("ignored", encoding="utf-8")

    resp = await client.get("/api/game/charts", headers=headers)
    assert resp.status_code == 200
    items = {c["name"]: c for c in resp.json()["charts"]}
    assert set(items) == {"good.pez", "broken.pez", "notazip.pez"}
    assert items["good.pez"]["valid"] is True
    assert items["good.pez"]["path"] == "/api/game/charts/good.pez"
    assert items["good.pez"]["size"] > 0
    # chart_id mirrors the client's id: md5 of the chart JSON text
    assert items["good.pez"]["chart_id"] == hashlib.md5(
        json.dumps({"formatVersion": 1}).encode("utf-8")
    ).hexdigest()
    assert items["broken.pez"]["valid"] is False
    assert "audio" in items["broken.pez"]["error"]
    assert items["notazip.pez"]["valid"] is False


async def test_chart_id_uses_last_json_like_the_client(client):
    _, headers = await register_and_login(client)
    from routers.game import get_charts_dir

    charts_dir = get_charts_dir()
    charts_dir.mkdir(parents=True, exist_ok=True)
    # The client's importer keeps the last .json in zip order as the chart;
    # the id must be taken from that same file.
    first = json.dumps({"formatVersion": 1, "tag": "decoy"}).encode("utf-8")
    last = json.dumps({"formatVersion": 3, "judgeLineList": []}).encode("utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a_first.json", first)
        zf.writestr("z_last.json", last)
        zf.writestr("song.mp3", b"fake-audio")
    (charts_dir / "two.pez").write_bytes(buf.getvalue())

    resp = await client.get("/api/game/charts", headers=headers)
    items = {c["name"]: c for c in resp.json()["charts"]}
    assert items["two.pez"]["valid"] is True
    assert items["two.pez"]["chart_id"] == hashlib.md5(last).hexdigest()


async def test_download_chart_file(client):
    _, headers = await register_and_login(client)
    from routers.game import get_charts_dir

    charts_dir = get_charts_dir()
    charts_dir.mkdir(parents=True, exist_ok=True)
    make_chart_package(charts_dir / "good.pez")

    resp = await client.get("/api/game/charts/good.pez", headers=headers)
    assert resp.status_code == 200
    assert resp.content[:2] == b"PK"

    resp = await client.get("/api/game/charts/missing.pez", headers=headers)
    assert resp.status_code == 404


async def test_download_rejects_bad_filenames(client):
    _, headers = await register_and_login(client)
    # "." is excluded: URL normalizers collapse /charts/. into the list route.
    for name in ("..%2Fsecret.pez", "sub/dir.pez", "evil.txt"):
        resp = await client.get(f"/api/game/charts/{name}", headers=headers)
        assert resp.status_code in (400, 404), name


async def test_download_supports_token_query_fallback(client):
    """Media-style loads cannot set headers; ?token= must authenticate too."""
    tokens, _ = await register_and_login(client)
    from routers.game import get_charts_dir

    charts_dir = get_charts_dir()
    charts_dir.mkdir(parents=True, exist_ok=True)
    make_chart_package(charts_dir / "good.pez")

    resp = await client.get(f"/api/game/charts/good.pez?token={tokens['access_token']}")
    assert resp.status_code == 200

    resp = await client.get("/api/game/charts/good.pez?token=garbage")
    assert resp.status_code == 401
