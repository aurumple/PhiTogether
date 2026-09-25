"""Password hashing (stdlib PBKDF2) and JWT issuing/verification.

Hash format: ``pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>`` — same family
as passlib's ``pbkdf2_sha256`` but implemented on hashlib only, so the server
keeps a minimal dependency list and runs on any modern Python.
"""
import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt

from config import get_settings

PBKDF2_ITERATIONS = 310_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        scheme, iterations, salt_b64, hash_b64 = hashed_password.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        actual = hashlib.pbkdf2_hmac(
            "sha256", plain_password.encode("utf-8"), salt, int(iterations)
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int, username: str, token_version: int) -> str:
    s = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(minutes=s.jwt_access_expire_minutes)
    payload = {
        "sub": str(user_id),
        "username": username,
        "ver": token_version,
        "exp": expire,
        "type": "access",
    }
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256")


def create_refresh_token(user_id: int, token_version: int) -> str:
    s = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(days=s.jwt_refresh_expire_days)
    payload = {
        "sub": str(user_id),
        "ver": token_version,
        "exp": expire,
        "type": "refresh",
    }
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict:
    s = get_settings()
    return jwt.decode(token, s.jwt_secret, algorithms=["HS256"])
