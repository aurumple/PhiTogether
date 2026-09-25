"""Registration / login / token refresh / current user."""
import re

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from database import get_db, get_first_user_count
from deps import get_current_user
from security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,32}$")


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=6, max_length=128)
    confirm_password: str = Field(min_length=6, max_length=128)
    nickname: str | None = Field(default=None, max_length=32)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(req: RegisterRequest, db=Depends(get_db)):
    if req.password != req.confirm_password:
        raise HTTPException(status_code=422, detail="Passwords do not match")
    if not _USERNAME_RE.match(req.username):
        raise HTTPException(
            status_code=422,
            detail="Username must be 3-32 characters (letters, digits, _ or -)",
        )
    nickname = (req.nickname or "").strip() or req.username

    is_first = await get_first_user_count(db) == 0
    try:
        cursor = await db.execute(
            "INSERT INTO users (username, nickname, password_hash, is_admin) "
            "VALUES (?, ?, ?, ?)",
            (req.username, nickname, hash_password(req.password), 1 if is_first else 0),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(status_code=409, detail="Username already taken")
        raise
    return {
        "id": cursor.lastrowid,
        "username": req.username,
        "nickname": nickname,
        "is_admin": is_first,
    }


@router.post("/login")
async def login(req: LoginRequest, db=Depends(get_db)):
    cursor = await db.execute(
        "SELECT id, username, password_hash, token_version FROM users WHERE username = ?",
        (req.username,),
    )
    user = await cursor.fetchone()
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong username or password")

    # Bump token_version so every previously issued token is invalidated
    # (single active session per account).
    new_version = user["token_version"] + 1
    await db.execute(
        "UPDATE users SET token_version = ? WHERE id = ?", (new_version, user["id"])
    )
    await db.commit()

    return TokenResponse(
        access_token=create_access_token(user["id"], user["username"], new_version),
        refresh_token=create_refresh_token(user["id"], new_version),
    )


@router.post("/refresh")
async def refresh(req: RefreshRequest, db=Depends(get_db)):
    try:
        payload = decode_token(req.refresh_token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type")

    user_id = int(payload["sub"])
    cursor = await db.execute(
        "SELECT id, username, token_version FROM users WHERE id = ?", (user_id,)
    )
    user = await cursor.fetchone()
    if not user or user["token_version"] != payload.get("ver"):
        raise HTTPException(status_code=401, detail="Token expired, please sign in again")

    return TokenResponse(
        access_token=create_access_token(user["id"], user["username"], user["token_version"]),
        refresh_token=create_refresh_token(user["id"], user["token_version"]),
    )


@router.get("/me")
async def me(user=Depends(get_current_user)):
    return {
        "id": user["id"],
        "username": user["username"],
        "nickname": user["nickname"],
        "is_admin": bool(user["is_admin"]),
    }
