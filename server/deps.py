"""Auth dependencies shared by the routers."""
from fastapi import Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.requests import Request
import jwt

from database import get_db
from security import decode_token

security = HTTPBearer(auto_error=False)

_USER_COLUMNS = "id, username, nickname, is_admin, token_version"


async def _authenticate(db, cred_token: str) -> dict:
    try:
        payload = decode_token(cred_token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")
    user_id = int(payload["sub"])
    cursor = await db.execute(
        f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
    )
    user = await cursor.fetchone()
    if not user or user["token_version"] != payload.get("ver"):
        raise HTTPException(status_code=401, detail="Token expired, please sign in again")
    return dict(user)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db=Depends(get_db),
):
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await _authenticate(db, credentials.credentials)


async def get_user_from_token_or_header(
    request: Request,
    token: str | None = Query(default=None),
    db=Depends(get_db),
):
    """Auth for media-style endpoints: Bearer header first, ``?token=`` fallback.

    Media elements (``<audio>``/``<img>``) fetch by URL and cannot set request
    headers, so the JWT may travel as a query parameter there.
    """
    auth_header = request.headers.get("authorization")
    cred_token = None
    if auth_header and auth_header.lower().startswith("bearer "):
        cred_token = auth_header[7:].strip()
    elif token:
        cred_token = token
    if not cred_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await _authenticate(db, cred_token)
