# PhiTogether — Self-Hosted Edition

[中文](README_zh.md) | English

Bringing multiplayer to Phigros gameplay! An open-source, non-commercial rhythm game based on Phigros.

This is a **self-hostable edition** of [Team-PhiTogether/PhiTogether](https://github.com/Team-PhiTogether/PhiTogether): instead of fetching charts from online chart communities (PhiZone / PT Community), every chart comes from **your own server**, and the leaderboard is a **local leaderboard** on that server.

## What changed compared to upstream

- **Charts come from the server only.** The PhiZone and PT-Community chart sources are removed. Fill the server with the bundled bulk tool (`server/tools/fetch_phigros_charts.py`, pulls the full Phigros chart set through GitHub mirrors) or drop `.pez` / `.zip` packages into `server/data/charts/` by hand. Local chart import and the bundled event charts still work.
- **Chapter-based single-player browser.** The single-player page lists every chart on the server grouped by the in-game Phigros chapters (Chapter Legacy, Side Stories, collaboration packs, 单曲精选集…, with 「隐秘」 for chapter-less hidden charts and 「其他」 for the rest), and unifies browsing, downloading and playing: a difficulty badge downloads when missing and plays when ready. List covers are cached in the background, there is no audio preview, and the standalone *Chart Management* page is gone (its cleanup tools moved to Settings). The server stores one audio per song and packs each difficulty download on demand, and the client keeps one audio record per song, so downloading every difficulty never duplicates audio.
- **Self-hosted leaderboard.** Players register on your server; best scores upload after each play (with an offline queue), and the leaderboard ranks everyone by RKS (mean of the best 30 charts). Every chart difficulty also has its own Top-10 board (score first, accuracy breaks ties, identical results share a rank): open it from the "榜单" button in the song browser, and the result screen shows your standing on that chart (even outside the Top 10). Guests can play, but their scores stay local.
- **A minimal server is included** (`server/`, Python + FastAPI): accounts (JWT), chart packages and the leaderboard — nothing else. See [server/README.md](server/README.md).
- **Multiplayer code is kept but disabled** (the room server it needs is not part of this edition); the entry shows a maintenance notice.
- **Low-performance-friendly default settings.** On first launch the game applies the recommended low-performance configuration: hide inactive (distant) notes, no background/UI blur, lower render resolution, no real-time delay calibration, and a 90 ms input offset. Everything stays adjustable in Settings.
- **OneTap module build.** `pnpm build:onetap` creates the sandboxed OneTap module. Its package resolves bundled assets locally, and its Settings checkboxes use CSS controls that work in Chrome 89 WebViews.
- No analytics, no external chart/community requests.

## Self-Hosting

Requirements: Python 3.11+, Node.js 18+, pnpm.

```bash
# 1. Install the frontend dependencies and build the client
pnpm install
pnpm build               # output in dist/

# 2. Set up the server
cd server
python -m venv .venv && .venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\pip
python main.py           # serves the API and the built client on http://127.0.0.1:8000
```

Then open `http://<host>:8000`, register (the first account becomes the admin) and start playing.

**Adding charts:** run `python tools/fetch_phigros_charts.py` in `server/` to pull the full Phigros chart library into `server/data/charts-lib/` (GitHub mirrors are used automatically; re-running fetches only what's missing), or put `.pez` / `.zip` chart packages into `server/data/charts/` by hand. Then hit *Refresh* on the in-game *Chart Management* page. Corrupt packages are flagged and can't be downloaded. See [server/README.md](server/README.md) for details.

For development, run `pnpm dev` (client on :1145) alongside `python server/main.py` — the dev server proxies `/api` to `:8000`.

More server options (data directory, JWT secret, bind address): see [server/README.md](server/README.md).

## 📃 LICENSE

The source code (excluding multimedia resources) is distributed under the [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) license.

For multimedia resources, we reserve all rights.

> Definition of `multimedia resources`
>
> Including but not limited to files with extensions containing `ogg`, `mp3`, `aac`, `wav`, `jp(e)g`, `png`, `svg`, `sketch`, `zip`, `au3`, `aup3-shm`, `aup3-wal`, `flp`.
>
> Including but not limited to files with file headers containing characteristics of `ogg`, `mp3`, `aac`, `wav`, `jp(e)g`, `png`, `svg`, `sketch`, `zip`, `au3`, `aup3-shm`, `aup3-wal`, `flp` file headers.

## ⭐ Acknowledgments

- Upstream project: [Team-PhiTogether/PhiTogether](https://github.com/Team-PhiTogether/PhiTogether).
- Based on [lchzh3473/sim-phi](https://github.com/lchzh3473/sim-phi).
- And you in front of the screen!

## Cached library and offline play

Both the standalone website and the OneTap module cache the complete song/chapter directory on the first online visit to Single Player. The list appears first; all list covers are then cached in the background as thumbnails (up to 192 pixels). Initial caching still fetches the original cover; later visits reuse the thumbnail and only refresh changed artwork. Progress is shown, interrupted work retries when idle, and cached lists remain visible when the server is unreachable. Audio and charts are downloaded only on request.

The first chapter is **Downloaded**, including local imports and only the difficulties available locally. It remains visible when empty, is selected on the first visit, and subsequent visits remember the selected chapter. The selection page has its own mouse/touch scrolling region. Its play settings include **Clear library information and thumbnails**, which preserves downloaded charts, favorites and scores.

Keep the game page open to play downloaded charts without the server. Valid runs are saved locally before upload, and the result screen and player card update RKS immediately using the existing best-30/highest-accuracy rules. Pending scores retry on reconnect, startup and every 30 seconds while the page is visible and outside gameplay. Server best-30 records are cached as the RKS baseline; before the first successful score sync the card marks the value as a local estimate. Guests remain local; standalone accounts have separate score/outbox namespaces, and OneTap uses host-isolated storage. Ambiguous old unscoped queues are preserved rather than attributed to another login. Browser/host storage must remain available; a fresh offline app launch is not guaranteed.

In OneTap, the player card retains **Local leaderboard** but hides login/switch/logout controls because the host owns the identity. Standalone account controls remain available.

Targeted client checks: `node script/check-library-cache.mjs` and `node script/check-offline-records.mjs`.
