# PhiTogether Server

A minimal self-hosted server for the PhiTogether self-hosted edition: accounts,
chart packages and a local leaderboard. Python 3.11+ / FastAPI / SQLite.

## Quick start

```bash
python -m venv .venv
# Windows: .venv\Scripts\pip ; Linux/macOS: .venv/bin/pip
.venv/bin/pip install -r requirements.txt

python main.py
# API + built client on http://127.0.0.1:8000
```

The server serves the built frontend from `../dist` (run `pnpm build` in the
repository root first). Without a build it serves the API only.

## Adding charts

There is intentionally **no web upload**: chart files are placed on the server
directly by the operator, either as packages or through the bulk fetch tool.

### Bulk Phigros chart library (recommended)

```bash
python tools/fetch_phigros_charts.py            # full library (~1 GB, one-off)
python tools/fetch_phigros_charts.py --limit 3  # smoke test
python tools/fetch_phigros_charts.py --force    # re-download everything
```

The tool pulls the whole Phigros chart set from the community-extracted archive
[7aGiven/Phigros_Resource](https://github.com/7aGiven/Phigros_Resource) into
`data/charts-lib/`. GitHub is not reachable reliably from mainland China, so
downloads go through a chain of public GitHub mirrors (`--mirrors` overrides it,
`--direct` skips it); re-running the tool is safe — existing files are kept and
only missing ones are fetched, so it doubles as an update/repair pass.

Layout (one audio + one cover per song, one JSON per difficulty — a song's
different difficulties **never duplicate the audio**):

```
data/charts-lib/<songID>/
    meta.json          name, composer, illustrator, per-difficulty rating/charter
    music.ogg
    illustration.png
    EZ.json HD.json IN.json [AT.json]
```

Each song x difficulty is listed in-game as a virtual `<songID>.<LEVEL>.pez` and
packed into a real .pez on demand when a player downloads it (the packing
reuses the shared audio, so the server never stores it twice).

### Manual packages

Put `.pez` / `.zip` chart packages into `data/charts/` (created automatically).
In the game, open *Chart Management* and hit *Refresh*; players can then
download packages into their browser cache. Packages are validated on listing —
a broken zip (missing chart JSON / audio) is flagged and cannot be downloaded.

## Configuration (environment variables)

| Variable        | Default            | Meaning                                          |
| --------------- | ------------------ | ------------------------------------------------ |
| `PT_DATA_DIR`   | `server/data`      | Data directory (SQLite DB, charts, JWT secret)   |
| `PT_JWT_SECRET` | generated & stored | JWT signing secret (persisted to `jwt_secret`)   |
| `PT_STATIC_DIR` | `../dist`          | Built frontend to serve                          |
| `PT_HOST`       | `127.0.0.1`        | Bind address for `python main.py`                |
| `PT_PORT`       | `8000`             | Bind port for `python main.py`                   |

The first registered account becomes the admin. Behind a reverse proxy
(Caddy/nginx) with HTTPS is the recommended production setup; the app itself is
same-origin only, so no CORS configuration is needed.

## API overview

All endpoints are under `/api`; authentication is `Authorization: Bearer <jwt>`
(chart downloads additionally accept `?token=<jwt>` for media-style loads).

- `POST /api/auth/register` `{username, password, confirm_password, nickname?}`
- `POST /api/auth/login` `{username, password}` → `{access_token, refresh_token}`
- `POST /api/auth/refresh` `{refresh_token}` → new token pair
- `GET  /api/auth/me` → `{id, username, nickname, is_admin}`
- `GET  /api/game/charts` → `{charts: [{name, path, size, valid, error, source,
  song_id, song_name, composer, illustrator, charter, level, rating, cover}]}` —
  merged view of manual packages (`source: "file"`) and shared-library entries
  (`source: "lib"`, virtual `<songID>.<LEVEL>.pez` built on demand)
- `GET  /api/game/charts/{filename}` → chart package download
- `GET  /api/game/covers/{song_id}` → cover art of a shared-library song
- `POST /api/game/pt/records` `{chart_id, song_name, difficulty, rating, score, acc, is_fc}` —
  upserts the caller's best score per chart
- `GET  /api/game/pt/leaderboard` → `{entries: [{user_id, name, rks, plays}], my_rank, my_rks}`
- `GET  /api/game/pt/me` → `{records: [...], rks, limit}`
- `GET  /api/health`

Score math: chart rks = `rating * (acc/100)^2`, player rks = mean of the best 30
charts. A record only replaces the stored one when it is better (score, then
accuracy, then full-combo).

## Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/ -v
```
