"""Authentication dependencies for FastAPI — user + legacy access-key support."""

import os
from datetime import datetime

from fastapi import Header, HTTPException, Depends, Request
import bcrypt as _bcrypt

from .db import get_db

# Role hierarchy: admin > read-write-approve > read-write > write-only
ROLE_LEVELS = {
    "write-only": 1,
    "read-write": 2,
    "read-write-approve": 3,
    "admin": 4,
}

SESSION_TTL_DAYS = int(os.getenv("SESSION_TTL_DAYS", "7"))


def hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


async def get_current_user(request: Request):
    """Validate Bearer token session and return user context."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None

    token = auth[7:]
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT s.token, s.user_id, s.account_id, s.project_id, s.expires_at,
                      u.email, u.name as user_name, u.disabled_at,
                      a.slug as account_slug, a.name as account_name,
                      p.slug as project_slug, p.name as project_name,
                      ur.role
               FROM sessions s
               JOIN users u ON s.user_id = u.id
               JOIN accounts a ON s.account_id = a.id
               JOIN projects p ON s.project_id = p.id
               LEFT JOIN user_roles ur ON ur.user_id = s.user_id
                                       AND ur.account_id = s.account_id
                                       AND ur.project_id = s.project_id
               WHERE s.token = ?""",
            (token,),
        )
        row = await cursor.fetchone()
        if not row:
            return None

        row = dict(row)

        # If no project-specific role, check for account-level admin
        if not row.get("role"):
            admin_cursor = await db.execute(
                """SELECT role FROM user_roles
                   WHERE user_id = ? AND account_id = ? AND role = 'admin'
                   LIMIT 1""",
                (row["user_id"], row["account_id"]),
            )
            admin_row = await admin_cursor.fetchone()
            if admin_row:
                row["role"] = "admin"

        # Check disabled
        if row.get("disabled_at"):
            return None

        # Check expiry
        if datetime.fromisoformat(row["expires_at"]) < datetime.utcnow():
            await db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            await db.commit()
            return None

        return {
            "id": row["user_id"],
            "user_id": row["user_id"],
            "email": row["email"],
            "user_name": row["user_name"],
            "account_id": row["account_id"],
            "account_slug": row["account_slug"],
            "account_name": row["account_name"],
            "project_id": row["project_id"],
            "project_slug": row["project_slug"],
            "project_name": row["project_name"],
            "role": row["role"] or "read-write",
            "auth_type": "session",
            "session_token": token,
        }
    finally:
        await db.close()


async def get_current_key(request: Request):
    """Legacy: validate X-Access-Key header."""
    key_val = request.headers.get("x-access-key")
    if not key_val:
        return None

    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT k.id, k.account_id, k.project_id, k.role, k.label,
                      a.slug as account_slug, a.name as account_name,
                      p.slug as project_slug, p.name as project_name
               FROM access_keys k
               JOIN accounts a ON k.account_id = a.id
               JOIN projects p ON k.project_id = p.id
               WHERE k.id = ? AND k.revoked_at IS NULL""",
            (key_val,),
        )
        row = await cursor.fetchone()
        if not row:
            return None
        result = dict(row)
        result["auth_type"] = "access_key"
        return result
    finally:
        await db.close()


async def get_authenticated(request: Request):
    """Try session auth first, then legacy access key. 401 if neither works."""
    user = await get_current_user(request)
    if user:
        return user

    key = await get_current_key(request)
    if key:
        return key

    raise HTTPException(status_code=401, detail="Authentication required. Provide Authorization: Bearer <token> or X-Access-Key header.")


def require_role(*roles):
    """Factory returning a dependency that requires one of the given roles."""
    async def checker(auth=Depends(get_authenticated)):
        if auth["role"] not in roles and auth["role"] != "admin":
            raise HTTPException(
                status_code=403,
                detail=f"Requires one of: {', '.join(roles)}. Your role: {auth['role']}",
            )
        return auth
    return checker
