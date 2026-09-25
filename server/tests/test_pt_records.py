"""Best-score upsert, rks math and the leaderboard."""
import pytest

from conftest import register_and_login


def record(chart_id, *, score=1_000_000, acc=100.0, rating=16.0, is_fc=True, name="Song", max_acc=None, run_at=None):
    data = {
        "chart_id": chart_id,
        "song_name": name,
        "difficulty": "IN Lv.16",
        "rating": rating,
        "score": score,
        "acc": acc,
        "is_fc": is_fc,
    }
    # Optional fields double as the legacy-client payload when omitted.
    if max_acc is not None:
        data["max_acc"] = max_acc
    if run_at is not None:
        data["run_at"] = run_at
    return data


async def test_record_upsert_keeps_the_better_score(client):
    _, headers = await register_and_login(client)

    resp = await client.post("/api/game/pt/records", json=record("c1", score=900_000, acc=95.0, rating=16.0), headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["improved"] is True
    assert body["record"]["chart_rks"] == round(16.0 * 0.95**2, 4)
    # Legacy payload without max_acc: best accuracy == run accuracy.
    assert body["record"]["best_acc"] == 95.0

    # Lower score is not merged as the best run.
    resp = await client.post("/api/game/pt/records", json=record("c1", score=800_000, acc=99.0), headers=headers)
    assert resp.json()["improved"] is False

    # Same score, better accuracy wins as the best run.
    resp = await client.post("/api/game/pt/records", json=record("c1", score=900_000, acc=97.0), headers=headers)
    assert resp.json()["improved"] is True

    me = (await client.get("/api/game/pt/me", headers=headers)).json()
    assert len(me["records"]) == 1
    assert me["records"][0]["score"] == 900_000
    assert me["records"][0]["acc"] == 97.0
    # rks keeps using the highest accuracy ever achieved (99%, not the run's 97%).
    assert me["records"][0]["best_acc"] == 99.0
    assert me["rks"] == round(16.0 * 0.99**2, 4)
    assert me["limit"] == 30


async def test_best_run_and_max_acc_are_tracked_separately(client):
    _, headers = await register_and_login(client)

    await client.post(
        "/api/game/pt/records",
        json=record("c1", score=1_000_000, acc=90.0, max_acc=90.0, run_at="2026-09-25T10:00:00Z"),
        headers=headers,
    )
    # Higher accuracy but lower score: rks improves, the best run stays put.
    resp = await client.post(
        "/api/game/pt/records",
        json=record("c1", score=950_000, acc=99.0, max_acc=99.0, run_at="2026-09-25T11:00:00Z"),
        headers=headers,
    )
    assert resp.json()["improved"] is False

    me = (await client.get("/api/game/pt/me", headers=headers)).json()
    row = me["records"][0]
    assert row["score"] == 1_000_000
    assert row["acc"] == 90.0
    assert row["best_acc"] == 99.0
    assert row["run_at"].startswith("2026-09-25T10:00")
    assert me["rks"] == round(16.0 * 0.99**2, 4)

    # A new best run replaces run fields (including its date) but not best_acc.
    resp = await client.post(
        "/api/game/pt/records",
        json=record("c1", score=1_000_000, acc=95.0, max_acc=95.0, run_at="2026-09-26T09:00:00Z"),
        headers=headers,
    )
    assert resp.json()["improved"] is True
    row = (await client.get("/api/game/pt/me", headers=headers)).json()["records"][0]
    assert row["acc"] == 95.0
    assert row["best_acc"] == 99.0
    assert row["run_at"].startswith("2026-09-26T09:00")


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


# ===== Per-chart leaderboard (top 10 ranks + my standing) =====


async def test_chart_leaderboard_ranks_and_ties(client):
    players = ["alice", "bob", "carol", "dave", "erin"]
    headers_by = {}
    for name in players:
        _, headers_by[name] = await register_and_login(client, username=name)

    plays = [
        ("alice", 1_000_000, 99.0, True),
        ("erin", 950_000, 98.0, False),
        ("bob", 950_000, 97.0, True),
        ("carol", 950_000, 97.0, True),
        ("dave", 950_000, 97.0, False),
    ]
    for i, (name, score, acc, is_fc) in enumerate(plays):
        await client.post(
            "/api/game/pt/records",
            json=record("c1", score=score, acc=acc, is_fc=is_fc,
                        max_acc=acc, run_at=f"2026-09-2{i % 5}T10:00:00Z"),
            headers=headers_by[name],
        )
    # A record on another chart must not leak into this board.
    await client.post(
        "/api/game/pt/records", json=record("other", score=1_000_000, acc=100.0), headers=headers_by["dave"]
    )

    body = (await client.get("/api/game/pt/chart-leaderboard?chart_id=c1", headers=headers_by["dave"])).json()
    assert [e["rank"] for e in body["entries"]] == [1, 2, 3, 3, 5]  # ties share a rank
    assert [e["name"] for e in body["entries"]] == ["ALICE", "ERIN", "BOB", "CAROL", "DAVE"]
    top = body["entries"][0]
    assert top["score"] == 1_000_000
    assert top["acc"] == 99.0
    assert top["is_fc"] is True
    assert top["is_me"] is False
    assert top["run_at"].startswith("2026-09-2")
    assert top["rks"] == round(16.0 * 0.99**2, 4)
    assert body["entries"][4]["is_me"] is True
    assert body["me"]["rank"] == 5
    assert body["me"]["name"] == "DAVE"
    assert body["me"]["is_fc"] is False


async def test_chart_leaderboard_top10_cutoff_and_my_rank(client):
    headers_by = {}
    for i in range(12):
        _, headers_by[i] = await register_and_login(client, username=f"player{i}")
        await client.post(
            "/api/game/pt/records",
            json=record("c1", score=900_000 + i * 1000, acc=90.0 + i * 0.5, max_acc=90.0 + i * 0.5),
            headers=headers_by[i],
        )

    # The lowest-ranked player still sees their complete standing.
    body = (await client.get("/api/game/pt/chart-leaderboard?chart_id=c1", headers=headers_by[0])).json()
    assert [e["rank"] for e in body["entries"]] == list(range(1, 11))
    assert body["me"]["rank"] == 12
    assert body["me"]["is_me"] is True
    assert body["me"]["score"] == 900_000

    # The best player sees themselves inside the board.
    body = (await client.get("/api/game/pt/chart-leaderboard?chart_id=c1", headers=headers_by[11])).json()
    assert body["entries"][0]["is_me"] is True
    assert body["me"]["rank"] == 1


async def test_chart_leaderboard_shared_cutoff_rank_includes_ties(client):
    # Everyone ties on rank 1: "top 10 ranks" still lists all of them.
    for i in range(12):
        _, headers = await register_and_login(client, username=f"tied{i}")
        await client.post(
            "/api/game/pt/records",
            json=record("c1", score=1_000_000, acc=100.0, max_acc=100.0),
            headers=headers,
        )
    _, headers = await register_and_login(client, username="solo")
    body = (await client.get("/api/game/pt/chart-leaderboard?chart_id=c1", headers=headers)).json()
    assert len(body["entries"]) == 12  # one shared rank, all rows shown
    assert {e["rank"] for e in body["entries"]} == {1}
    assert body["me"] is None


async def test_chart_leaderboard_empty_and_auth(client):
    _, headers = await register_and_login(client)
    body = (await client.get("/api/game/pt/chart-leaderboard?chart_id=none", headers=headers)).json()
    assert body == {"chart_id": "none", "entries": [], "me": None}
    assert (await client.get("/api/game/pt/chart-leaderboard?chart_id=none")).status_code == 401
