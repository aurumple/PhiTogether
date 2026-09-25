"""Shared chart library: virtual .pez listing, on-demand packing, covers."""
import hashlib
import io
import json
import zipfile

from conftest import register_and_login


def make_lib_song(song_id="Test.Song", levels=("EZ", "IN"), with_music=True):
    from routers.game import get_charts_lib_dir

    song_dir = get_charts_lib_dir() / song_id
    song_dir.mkdir(parents=True, exist_ok=True)
    charts = []
    for level in levels:
        (song_dir / f"{level}.json").write_text(
            json.dumps({"formatVersion": 3, "judgeLineList": []}), encoding="utf-8"
        )
        charts.append({"level": level, "rating": 12.6, "charter": "Tester", "file": f"{level}.json"})
    if with_music:
        (song_dir / "music.ogg").write_bytes(b"fake-audio")
    (song_dir / "illustration.png").write_bytes(b"fake-cover")
    (song_dir / "meta.json").write_text(
        json.dumps(
            {
                "id": song_id,
                "name": "Test Song",
                "composer": "Composer",
                "illustrator": "Illustrator",
                "charts": charts,
                "chapter": "Chapter 5 霓虹灯牌",
                "chapter_order": 1,
            }
        ),
        encoding="utf-8",
    )
    return song_dir


async def test_list_charts_merges_shared_lib(client):
    _, headers = await register_and_login(client)
    make_lib_song()

    resp = await client.get("/api/game/charts", headers=headers)
    assert resp.status_code == 200
    items = {c["name"]: c for c in resp.json()["charts"]}
    assert set(items) == {"Test.Song.EZ.pez", "Test.Song.IN.pez"}
    ez = items["Test.Song.EZ.pez"]
    assert ez["valid"] is True
    assert ez["source"] == "lib"
    assert ez["song_id"] == "Test.Song"
    assert ez["song_name"] == "Test Song"
    assert ez["composer"] == "Composer"
    assert ez["charter"] == "Tester"
    assert ez["level"] == "EZ"
    assert ez["rating"] == 12.6
    assert ez["cover"] == "/api/game/covers/Test.Song"
    assert ez["size"] > 0
    assert ez["path"] == "/api/game/charts/Test.Song.EZ.pez"
    assert ez["chapter"] == "Chapter 5 霓虹灯牌"
    assert ez["chapter_order"] == 1
    # chart_id mirrors the client's id: md5 of the chart JSON text
    assert ez["chart_id"] == hashlib.md5(
        json.dumps({"formatVersion": 3, "judgeLineList": []}).encode("utf-8")
    ).hexdigest()


async def test_list_charts_includes_chapter_index(client):
    _, headers = await register_and_login(client)

    resp = await client.get("/api/game/charts", headers=headers)
    assert resp.status_code == 200
    chapters = resp.json()["chapters"]
    assert isinstance(chapters, list)
    # the shipped reference data always defines these three buckets
    names = [c["name"] for c in chapters]
    assert "单曲精选集" in names and "隐秘" in names and "其他" in names


async def test_download_virtual_pez_packs_shared_audio(client):
    _, headers = await register_and_login(client)
    make_lib_song(levels=("EZ",))

    resp = await client.get("/api/game/charts/Test.Song.EZ.pez", headers=headers)
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = set(zf.namelist())
        assert names == {"info.txt", "Test.Song.json", "Test.Song.ogg", "Test.Song.png"}
        info = zf.read("info.txt").decode("utf-8")
        assert "Name: Test Song" in info
        assert "Level: EZ Lv.12.6" in info
        assert "Charter: Tester" in info
        assert json.loads(zf.read("Test.Song.json"))["formatVersion"] == 3
        assert zf.read("Test.Song.ogg") == b"fake-audio"


async def test_download_virtual_pez_bad_names(client):
    _, headers = await register_and_login(client)
    make_lib_song(levels=("EZ",))

    # an encoded path separator is rejected (routing layer or the name check)
    assert (await client.get("/api/game/charts/bad%2Fname.pez", headers=headers)).status_code in (400, 404)
    assert (await client.get("/api/game/charts/Test.Song.EZ.txt", headers=headers)).status_code == 400
    # unknown difficulty level and unknown song are plain 404s
    assert (await client.get("/api/game/charts/Test.Song.XX.pez", headers=headers)).status_code == 404
    assert (await client.get("/api/game/charts/Missing.Song.IN.pez", headers=headers)).status_code == 404


async def test_download_virtual_pez_missing_difficulty(client):
    _, headers = await register_and_login(client)
    make_lib_song(levels=("EZ",))

    resp = await client.get("/api/game/charts/Test.Song.IN.pez", headers=headers)
    assert resp.status_code == 404


async def test_song_without_music_is_not_listed(client):
    _, headers = await register_and_login(client)
    make_lib_song(with_music=False)

    resp = await client.get("/api/game/charts", headers=headers)
    assert resp.json()["charts"] == []


async def test_cover_endpoint(client):
    _, headers = await register_and_login(client)
    make_lib_song()

    resp = await client.get("/api/game/covers/Test.Song", headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.content == b"fake-cover"

    assert (await client.get("/api/game/covers/Missing.Song", headers=headers)).status_code == 404
    # an encoded path separator is rejected (routing layer or the name check)
    assert (await client.get("/api/game/covers/bad%2Fid", headers=headers)).status_code in (400, 404)


async def test_lib_entries_require_auth(client):
    make_lib_song()
    assert (await client.get("/api/game/charts")).status_code == 401
    assert (await client.get("/api/game/charts/Test.Song.EZ.pez")).status_code == 401
