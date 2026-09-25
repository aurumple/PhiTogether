"""Server configuration.

Environment variables:
- ``PT_DATA_DIR``    data directory (default ``<server dir>/data``)
- ``PT_JWT_SECRET``  stable JWT signing secret (default: generated once and
  persisted to ``<data_dir>/jwt_secret`` so restarts don't log everyone out)
- ``PT_STATIC_DIR``  frontend build output to serve (default ``<repo>/dist``)
- ``PT_HOST`` / ``PT_PORT``  bind address for ``python main.py`` (127.0.0.1:8000)
"""
import logging
import os
import secrets
import sys
import tempfile
from pathlib import Path

_log = logging.getLogger(__name__)


def server_root() -> Path:
    return Path(__file__).resolve().parent


def _default_data_dir() -> str:
    if getattr(sys, "frozen", False):
        return str(Path(sys.executable).parent / "data")
    return str(server_root() / "data")


def _chmod_600(path: str) -> None:
    """Best effort: keep the secret file owner-only (no-op on Windows)."""
    try:
        os.chmod(path, 0o600)
    except (OSError, NotImplementedError):
        pass


def _resolve_jwt_secret(data_dir: str) -> str:
    env_secret = os.environ.get("PT_JWT_SECRET")
    if env_secret:
        return env_secret

    secret_path = Path(data_dir) / "jwt_secret"
    try:
        existing = secret_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except (OSError, ValueError):
        pass

    new_secret = secrets.token_urlsafe(48)
    try:
        Path(data_dir).mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=data_dir, prefix=".jwt_secret.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(new_secret)
            os.replace(tmp, secret_path)
            _chmod_600(str(secret_path))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError:
        _log.warning(
            "Cannot persist JWT secret to %s (read-only?); using an in-memory "
            "random secret. All logins will be invalidated on restart — set "
            "PT_JWT_SECRET in production.",
            secret_path,
        )
        return new_secret
    _log.info("Generated and persisted a new JWT secret: %s", secret_path)
    return new_secret


class Settings:
    def __init__(self) -> None:
        self.data_dir: str = os.environ.get("PT_DATA_DIR") or _default_data_dir()
        self.db_path: str = str(Path(self.data_dir) / "phitogether.db")
        self.charts_dir: str = str(Path(self.data_dir) / "charts")
        self.jwt_secret: str = _resolve_jwt_secret(self.data_dir)
        self.jwt_access_expire_minutes: int = 15
        self.jwt_refresh_expire_days: int = 7
        self.static_dir: str = os.environ.get("PT_STATIC_DIR") or str(
            server_root().parent / "dist"
        )
        self.host: str = os.environ.get("PT_HOST", "127.0.0.1")
        self.port: int = int(os.environ.get("PT_PORT", "8000"))


_settings_singleton: Settings | None = None


def get_settings() -> Settings:
    global _settings_singleton
    if _settings_singleton is None:
        _settings_singleton = Settings()
    return _settings_singleton
