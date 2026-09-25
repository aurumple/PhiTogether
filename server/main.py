"""PhiTogether self-hosted server: chart packages + local leaderboard + static SPA.

Run with ``python main.py`` (or ``uvicorn main:app --host 0.0.0.0 --port 8000``).
The built frontend (``pnpm build`` → ``dist/``) is served from the same origin,
so the client talks to ``/api/*`` with no CORS setup.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import Scope

from config import get_settings
from database import init_db
from routers.auth import router as auth_router
from routers.game import router as game_router

logging.basicConfig(level=logging.INFO)


class SpaStaticFiles(StaticFiles):
    """Static file server with SPA history-mode fallback.

    Unknown paths fall back to ``index.html`` so the client-side router handles
    deep links and 404 pages. ``/api/*`` keeps its JSON 404 semantics, and
    missing files *with* an extension stay 404 (a stale chunk URL must never
    resolve to HTML — the browser would cache the SPA shell as JavaScript).
    """

    async def get_response(self, path: str, scope) -> Response:
        missing_response = None
        try:
            response = await super().get_response(path, scope)
            if response.status_code != 404:
                return response
            missing_response = response
        except (HTTPException, StarletteHTTPException) as ex:
            if ex.status_code != 404:
                raise
        full_path = scope.get("path", "")
        if full_path.startswith("/api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        if Path(path).suffix:
            return missing_response or Response(
                "Not Found", status_code=404, media_type="text/plain"
            )
        return await super().get_response("index.html", scope)

    def file_response(
        self,
        full_path,
        stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        disk_path = str(full_path).replace("\\", "/")
        # Hashed Vite assets can be cached forever; everything else revalidates.
        if "/assets/" in disk_path:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    static_dir = Path(get_settings().static_dir)
    if static_dir.is_dir():
        app.mount("/", SpaStaticFiles(directory=str(static_dir), html=True), name="static")
    else:
        logging.warning(
            "Frontend build not found at %s — serving API only. Run `pnpm build` "
            "in the repo root and restart, or set PT_STATIC_DIR.",
            static_dir,
        )
    yield


app = FastAPI(title="PhiTogether Server", lifespan=lifespan)
app.include_router(auth_router)
app.include_router(game_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


def main() -> None:
    import uvicorn

    s = get_settings()
    uvicorn.run(app, host=s.host, port=s.port)


if __name__ == "__main__":
    main()
