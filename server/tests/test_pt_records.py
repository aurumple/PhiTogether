"""Best-score upsert, rks math and the leaderboard."""
import pytest

from conftest import register_and_login


def record(chart_id, *, score=1_000_000, acc=100.0, rating=16.0, is_fc=True, name="Song"):
    return {
        "chart_id": chart_id,
        "song_name": name,
        "difficulty": "IN Lv.16",
        "rating": rating,
        "score": score,
        "acc": acc,
        "is_fc": is_fc,
    }


async def test_record_upsert_keeps_the_better_score(client):
    _, headers = await register_and_login(client)

    resp = await client.post("/api/game/pt/records", json=record("c1", score=900_000, acc=95.0, rating=16.0), headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["improved"] is True
    assert body["record"]["chart_rks"] == round(16.0 * 0.95**2, 4)

    # Lower score is not merged.
    resp = await client.post("/api/game/pt/records", json=record("c1", score=800_000, acc=99.0), headers=headers)
    assert resp.json()["improved"] is False

    # Same score, better accuracy wins.
    resp = await client.post("/api/game/pt/records", json=record("c1", score=900_000, acc=97.0), headers=headers)
    assert resp.json()["improved"] is True

    me = (await client.get("/api/game/pt/me", headers=headers)).json()
    assert len(me["records"]) == 1
    assert me["records"][0]["score"] == 900_000
    assert me["records"][0]["acc"] == 97.0
    assert me["rks"] == round(16.0 * 0.97**2, 4)
    assert me["limit"] == 30


async def test_score_beats_acc_and_fc_as_tiebreakers(client):
    _, headers = await register_and_login(client)
    await client.post("/api/game/pt/records", json=record("c1", score=1_000_000, acc=90.0, is_fc=False), headers=headers)
    # Same score+acc, FC promotion counts as improvement.
    resp = await client.post("/api/game/pt/records", json=record("c1", score=1_000_000, acc=90.0, is_fc=True), headers=headers)
    assert resp.json()["improved"] is True
    # Score dominates: lower acc but higher score still wins.
    resp = await client.post("/api/game/pt/records", json=record("c1", score=1_000_001, acc=80.0, is_fc=False), headers=headers)
    assert resp.json()["improved"] is True


async def test_rks_is_mean_of_best_30(client):
    _, headers = await register_and_login(client)
    # 31 charts with acc 100%: chart_rks == rating.
    ratings = [10 + i * 0.1 for i in range(31)]
    for i, rating in enumerate(ratings):
        resp = await client.post(
            "/api/game/pt/records",
            json=record(f"c{i}", rating=rating, acc=100.0),
            headers=headers,
        )
        assert resp.json()["record"]["chart_rks"] == round(rating, 4)

    me = (await client.get("/api/game/pt/me", headers=headers)).json()
    expected = sum(sorted(ratings, reverse=True)[:30]) / 30
    assert me["rks"] == pytest.approx(expected, abs=1e-4)
    assert len(me["records"]) == 30  # only the best 30 rows are listed
    assert me["records"][0]["chart_id"] == "c30"  # highest rating first


async def test_leaderboard_ranks_users(client):
    _, headers_a = await register_and_login(client, username="alice")
    _, headers_b = await register_and_login(client, username="bob")

    await client.post("/api/game/pt/records", json=record("c1", rating=16.0, acc=100.0), headers=headers_a)
    await client.post("/api/game/pt/records", json=record("c1", rating=16.0, acc=50.0), headers=headers_b)
    await client.post("/api/game/pt/records", json=record("c2", rating=12.0, acc=100.0), headers=headers_b)

    resp = await client.get("/api/game/pt/leaderboard", headers=headers_b)
    body = resp.json()
    assert [e["name"] for e in body["entries"]] == ["ALICE", "BOB"]
    assert body["entries"][0]["rks"] == 16.0
    assert body["entries"][1]["rks"] == round((16.0 * 0.25 + 12.0) / 2, 4)
    assert body["entries"][1]["plays"] == 2
    assert body["my_rank"] == 2
    assert body["my_rks"] == body["entries"][1]["rks"]


async def test_leaderboard_empty_state(client):
    _, headers = await register_and_login(client)
    body = (await client.get("/api/game/pt/leaderboard", headers=headers)).json()
    assert body == {"entries": [], "my_rank": None, "my_rks": 0.0}
