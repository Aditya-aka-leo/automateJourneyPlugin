"""
Registry Service
================
Multi-tenant account/project management with user authentication and test approval.

Auth Endpoints:
  POST /auth/login           — Email/password login → session token
  POST /auth/logout          — Invalidate session
  POST /auth/switch-context  — Switch active account/project

User Management (admin):
  POST /users                — Create user with roles
  GET  /users                — List users in current account
  PUT  /users/{id}           — Update user (name, password, disable)
  DELETE /users/{id}         — Soft-disable user
  POST /users/{id}/roles     — Add role to user
  DELETE /users/{id}/roles/{role_id} — Remove role
  GET  /users/{id}/roles     — List user roles

Legacy (deprecated):
  POST /keys                 — Create access key
  GET  /keys                 — List keys
  DELETE /keys/{id}          — Revoke key

Other:
  POST /bootstrap            — Create first account + admin user
  GET  /me                   — Current auth context + available accounts
  GET  /accounts/{slug}      — Account details (admin)
  POST /accounts/{slug}/projects — Create project (admin)
  GET  /accounts/{slug}/projects — List projects (admin)
  DELETE /accounts/{slug}/projects/{pslug} — Delete project (admin)
  GET  /tests                — List tests (read-write+)
  GET  /tests/{id}           — Get test spec + metadata (read-write+)
  POST /tests                — Push test to pending (write-only+)
  POST /tests/{id}/approve   — Approve pending test (read-write-approve+)
  POST /tests/{id}/reject    — Reject pending test (read-write-approve+)
  DELETE /tests/{id}         — Delete test (read-write-approve+)
"""

import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .db import get_db, init_db
from .auth import (
    get_authenticated, require_role, get_current_user,
    hash_password, verify_password, SESSION_TTL_DAYS,
)
from .scaffold import scaffold_project, get_project_path, TESTS_ROOT

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("registry")

ADMIN_BOOTSTRAP_SECRET = os.getenv("ADMIN_BOOTSTRAP_SECRET", "changeme")

app = FastAPI(title="Autotest Registry", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    await init_db()
    TESTS_ROOT.mkdir(parents=True, exist_ok=True)
    # Clean expired sessions
    db = await get_db()
    try:
        await db.execute("DELETE FROM sessions WHERE expires_at < datetime('now')")
        await db.commit()
    finally:
        await db.close()

    # Auto-seed default admin user if no users exist
    db = await get_db()
    try:
        cursor = await db.execute("SELECT count(*) as cnt FROM users")
        row = await cursor.fetchone()
        if dict(row)["cnt"] == 0:
            log.info("[SEED] No users found — creating default admin/admin")
            account_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO accounts (id, slug, name) VALUES (?, ?, ?)",
                (account_id, "default", "Default Account"),
            )
            project_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO projects (id, account_id, slug, name) VALUES (?, ?, ?, ?)",
                (project_id, account_id, "default", "Default Project"),
            )
            scaffold_project("default", "default")
            user_id = str(uuid.uuid4())
            pw_hash = hash_password("admin")
            await db.execute(
                "INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)",
                (user_id, "admin", "Admin", pw_hash),
            )
            role_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO user_roles (id, user_id, account_id, project_id, role) VALUES (?, ?, ?, ?, ?)",
                (role_id, user_id, account_id, project_id, "admin"),
            )
            await db.commit()
            log.info("[SEED] Default admin user created (admin/admin)")
    finally:
        await db.close()

    log.info("Registry started. DB initialized. TESTS_ROOT=%s", TESTS_ROOT)


# ── Request/Response Models ──────────────────────────────────────

class BootstrapRequest(BaseModel):
    account_slug: str
    account_name: str
    admin_email: str = ""
    admin_password: str = ""
    admin_name: str = "Admin"

class LoginRequest(BaseModel):
    email: str
    password: str

class SwitchContextRequest(BaseModel):
    account_id: str
    project_id: str

class CreateUserRequest(BaseModel):
    email: str
    name: str
    password: str
    roles: List[dict] = []  # [{account_id, project_id, role}]

class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    disabled: Optional[bool] = None

class AddRoleRequest(BaseModel):
    account_id: str
    project_id: str
    role: str

class CreateProjectRequest(BaseModel):
    slug: str
    name: str

class CreateKeyRequest(BaseModel):
    project_id: str
    role: str
    label: str = ""

class PushTestRequest(BaseModel):
    test_name: str
    spec_code: str
    target_url: str = ""
    prompt: str = ""

class UpdateTestRequest(BaseModel):
    spec_code: str | None = None
    test_name: str | None = None
    target_url: str | None = None

class ApproveRejectRequest(BaseModel):
    comment: str = ""

class CreateAccountRequest(BaseModel):
    slug: str
    name: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


# ── Health ────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"ok": True, "service": "registry"}


# ── Auth Endpoints ───────────────────────────────────────────────

@app.post("/auth/login")
async def login(request: LoginRequest):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, email, name, password, disabled_at FROM users WHERE email = ?",
            (request.email,),
        )
        user = await cursor.fetchone()
        if not user:
            raise HTTPException(status_code=401, detail="Invalid email or password")

        user = dict(user)
        if user.get("disabled_at"):
            raise HTTPException(status_code=401, detail="Account is disabled")

        if not verify_password(request.password, user["password"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        # Get all roles for this user
        cursor = await db.execute(
            """SELECT ur.id as role_id, ur.account_id, ur.project_id, ur.role,
                      a.slug as account_slug, a.name as account_name,
                      p.slug as project_slug, p.name as project_name
               FROM user_roles ur
               JOIN accounts a ON ur.account_id = a.id
               JOIN projects p ON ur.project_id = p.id
               WHERE ur.user_id = ?
               ORDER BY a.name, p.name""",
            (user["id"],),
        )
        roles = [dict(r) for r in await cursor.fetchall()]

        if not roles:
            raise HTTPException(status_code=403, detail="No roles assigned. Contact an admin.")

        # Create session with the first role's context
        first = roles[0]
        token = str(uuid.uuid4())
        expires = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).isoformat()

        await db.execute(
            "INSERT INTO sessions (token, user_id, account_id, project_id, expires_at) VALUES (?, ?, ?, ?, ?)",
            (token, user["id"], first["account_id"], first["project_id"], expires),
        )
        await db.commit()

        log.info("[AUTH] User '%s' logged in", user["email"])
        return {
            "ok": True,
            "token": token,
            "user": {"id": user["id"], "name": user["name"], "email": user["email"]},
            "roles": roles,
            "current": {
                "account_id": first["account_id"],
                "account_slug": first["account_slug"],
                "account_name": first["account_name"],
                "project_id": first["project_id"],
                "project_slug": first["project_slug"],
                "project_name": first["project_name"],
                "role": first["role"],
            },
        }
    finally:
        await db.close()


@app.post("/auth/logout")
async def logout(auth=Depends(get_authenticated)):
    if auth.get("session_token"):
        db = await get_db()
        try:
            await db.execute("DELETE FROM sessions WHERE token = ?", (auth["session_token"],))
            await db.commit()
        finally:
            await db.close()
    return {"ok": True}


@app.post("/auth/switch-context")
async def switch_context(request: SwitchContextRequest, auth=Depends(get_authenticated)):
    db = await get_db()
    try:
        # Verify user has a role for this account+project
        cursor = await db.execute(
            """SELECT ur.role, a.slug as account_slug, a.name as account_name,
                      p.slug as project_slug, p.name as project_name
               FROM user_roles ur
               JOIN accounts a ON ur.account_id = a.id
               JOIN projects p ON ur.project_id = p.id
               WHERE ur.user_id = ? AND ur.account_id = ? AND ur.project_id = ?""",
            (auth["user_id"] if auth.get("auth_type") == "session" else auth["id"],
             request.account_id, request.project_id),
        )
        role_row = await cursor.fetchone()
        if not role_row:
            raise HTTPException(status_code=403, detail="No access to this account/project")

        role_row = dict(role_row)

        # Delete old session, create new one
        if auth.get("session_token"):
            await db.execute("DELETE FROM sessions WHERE token = ?", (auth["session_token"],))

        new_token = str(uuid.uuid4())
        expires = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).isoformat()
        user_id = auth["user_id"] if auth.get("auth_type") == "session" else auth["id"]

        await db.execute(
            "INSERT INTO sessions (token, user_id, account_id, project_id, expires_at) VALUES (?, ?, ?, ?, ?)",
            (new_token, user_id, request.account_id, request.project_id, expires),
        )
        await db.commit()

        log.info("[AUTH] Context switched to %s/%s", role_row["account_slug"], role_row["project_slug"])
        return {
            "ok": True,
            "token": new_token,
            "account_id": request.account_id,
            "account_slug": role_row["account_slug"],
            "account_name": role_row["account_name"],
            "project_id": request.project_id,
            "project_slug": role_row["project_slug"],
            "project_name": role_row["project_name"],
            "role": role_row["role"],
        }
    finally:
        await db.close()


# ── Bootstrap ────────────────────────────────────────────────────

@app.post("/bootstrap")
async def bootstrap(request: BootstrapRequest, x_bootstrap_secret: str = Header(...)):
    if x_bootstrap_secret != ADMIN_BOOTSTRAP_SECRET:
        raise HTTPException(status_code=403, detail="Invalid bootstrap secret")

    db = await get_db()
    try:
        # Check if account already exists
        cursor = await db.execute("SELECT id FROM accounts WHERE slug = ?", (request.account_slug,))
        if await cursor.fetchone():
            raise HTTPException(status_code=409, detail=f"Account '{request.account_slug}' already exists")

        account_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO accounts (id, slug, name) VALUES (?, ?, ?)",
            (account_id, request.account_slug, request.account_name),
        )

        # Create a default project
        project_id = str(uuid.uuid4())
        default_project_slug = "default"
        await db.execute(
            "INSERT INTO projects (id, account_id, slug, name) VALUES (?, ?, ?, ?)",
            (project_id, account_id, default_project_slug, "Default Project"),
        )

        scaffold_project(request.account_slug, default_project_slug)

        # Legacy: still create an access key for backward compat
        admin_key_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO access_keys (id, account_id, project_id, role, label) VALUES (?, ?, ?, ?, ?)",
            (admin_key_id, account_id, project_id, "admin", "Bootstrap admin key"),
        )

        result = {
            "ok": True,
            "account_id": account_id,
            "account_slug": request.account_slug,
            "project_id": project_id,
            "project_slug": default_project_slug,
            "admin_key": admin_key_id,
        }

        # Create admin user if email/password provided
        if request.admin_email and request.admin_password:
            # Check if email already used
            cursor = await db.execute("SELECT id FROM users WHERE email = ?", (request.admin_email,))
            if await cursor.fetchone():
                raise HTTPException(status_code=409, detail=f"Email '{request.admin_email}' already in use")

            user_id = str(uuid.uuid4())
            pw_hash = hash_password(request.admin_password)
            await db.execute(
                "INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)",
                (user_id, request.admin_email, request.admin_name, pw_hash),
            )

            role_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO user_roles (id, user_id, account_id, project_id, role) VALUES (?, ?, ?, ?, ?)",
                (role_id, user_id, account_id, project_id, "admin"),
            )

            # Create session
            token = str(uuid.uuid4())
            expires = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).isoformat()
            await db.execute(
                "INSERT INTO sessions (token, user_id, account_id, project_id, expires_at) VALUES (?, ?, ?, ?, ?)",
                (token, user_id, account_id, project_id, expires),
            )

            result["user_id"] = user_id
            result["session_token"] = token
            log.info("[BOOTSTRAP] Admin user '%s' created", request.admin_email)

        await db.commit()
        log.info("[BOOTSTRAP] Account '%s' created", request.account_slug)

        return result
    finally:
        await db.close()


# ── Me ───────────────────────────────────────────────────────────

@app.get("/me")
async def me(auth=Depends(get_authenticated)):
    result = {
        "ok": True,
        "account_id": auth["account_id"],
        "account_slug": auth["account_slug"],
        "account_name": auth["account_name"],
        "project_id": auth["project_id"],
        "project_slug": auth["project_slug"],
        "project_name": auth["project_name"],
        "role": auth["role"],
        "auth_type": auth.get("auth_type", "access_key"),
    }

    # If session-based, also return user info and all available roles
    if auth.get("auth_type") == "session":
        result["user_id"] = auth["user_id"]
        result["user_name"] = auth.get("user_name", "")
        result["email"] = auth.get("email", "")

        db = await get_db()
        try:
            cursor = await db.execute(
                """SELECT ur.account_id, ur.project_id, ur.role,
                          a.slug as account_slug, a.name as account_name,
                          p.slug as project_slug, p.name as project_name
                   FROM user_roles ur
                   JOIN accounts a ON ur.account_id = a.id
                   JOIN projects p ON ur.project_id = p.id
                   WHERE ur.user_id = ?
                   ORDER BY a.name, p.name""",
                (auth["user_id"],),
            )
            result["available_roles"] = [dict(r) for r in await cursor.fetchall()]
        finally:
            await db.close()

    return result


# ── User Management (admin) ──────────────────────────────────────

@app.post("/users")
async def create_user(request: CreateUserRequest, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        # Check email uniqueness
        cursor = await db.execute("SELECT id FROM users WHERE email = ?", (request.email,))
        if await cursor.fetchone():
            raise HTTPException(status_code=409, detail=f"Email '{request.email}' already in use")

        user_id = str(uuid.uuid4())
        pw_hash = hash_password(request.password)
        await db.execute(
            "INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)",
            (user_id, request.email, request.name, pw_hash),
        )

        # Add roles
        for r in request.roles:
            role_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO user_roles (id, user_id, account_id, project_id, role) VALUES (?, ?, ?, ?, ?)",
                (role_id, user_id, r["account_id"], r["project_id"], r["role"]),
            )

        await db.commit()
        log.info("[USER] Created '%s' (%s)", request.email, user_id[:8])
        return {"ok": True, "user_id": user_id}
    finally:
        await db.close()


@app.get("/users")
async def list_users(auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT DISTINCT u.id, u.email, u.name, u.created_at, u.disabled_at
               FROM users u
               JOIN user_roles ur ON u.id = ur.user_id
               WHERE ur.account_id = ?
               ORDER BY u.name""",
            (auth["account_id"],),
        )
        users = []
        for u in await cursor.fetchall():
            u = dict(u)
            # Get roles for this user in this account
            rc = await db.execute(
                """SELECT ur.id as role_id, ur.project_id, ur.role,
                          p.slug as project_slug, p.name as project_name
                   FROM user_roles ur
                   JOIN projects p ON ur.project_id = p.id
                   WHERE ur.user_id = ? AND ur.account_id = ?""",
                (u["id"], auth["account_id"]),
            )
            u["roles"] = [dict(r) for r in await rc.fetchall()]
            users.append(u)
        return {"ok": True, "users": users}
    finally:
        await db.close()


@app.put("/users/{user_id}")
async def update_user(user_id: str, request: UpdateUserRequest, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        # Verify user exists and belongs to this account
        cursor = await db.execute(
            "SELECT ur.id FROM user_roles ur WHERE ur.user_id = ? AND ur.account_id = ?",
            (user_id, auth["account_id"]),
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="User not found in this account")

        if request.name is not None:
            await db.execute("UPDATE users SET name = ? WHERE id = ?", (request.name, user_id))

        if request.password is not None:
            pw_hash = hash_password(request.password)
            await db.execute("UPDATE users SET password = ? WHERE id = ?", (pw_hash, user_id))

        if request.disabled is not None:
            if request.disabled:
                await db.execute("UPDATE users SET disabled_at = datetime('now') WHERE id = ?", (user_id,))
                # Invalidate all sessions for this user
                await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            else:
                await db.execute("UPDATE users SET disabled_at = NULL WHERE id = ?", (user_id,))

        await db.commit()
        log.info("[USER] Updated %s", user_id[:8])
        return {"ok": True}
    finally:
        await db.close()


@app.delete("/users/{user_id}")
async def disable_user(user_id: str, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT ur.id FROM user_roles ur WHERE ur.user_id = ? AND ur.account_id = ?",
            (user_id, auth["account_id"]),
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="User not found in this account")

        await db.execute("UPDATE users SET disabled_at = datetime('now') WHERE id = ?", (user_id,))
        await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        await db.commit()
        log.info("[USER] Disabled %s", user_id[:8])
        return {"ok": True}
    finally:
        await db.close()


@app.post("/users/{user_id}/roles")
async def add_user_role(user_id: str, request: AddRoleRequest, auth=Depends(require_role("admin"))):
    valid_roles = ("write-only", "read-write", "read-write-approve", "admin")
    if request.role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {valid_roles}")

    db = await get_db()
    try:
        # Verify project belongs to the specified account
        cursor = await db.execute(
            "SELECT id FROM projects WHERE id = ? AND account_id = ?",
            (request.project_id, request.account_id),
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Project not found in this account")

        role_id = str(uuid.uuid4())
        try:
            await db.execute(
                "INSERT INTO user_roles (id, user_id, account_id, project_id, role) VALUES (?, ?, ?, ?, ?)",
                (role_id, user_id, request.account_id, request.project_id, request.role),
            )
        except Exception:
            raise HTTPException(status_code=409, detail="User already has a role for this account/project")

        await db.commit()
        log.info("[ROLE] Added %s role for user %s", request.role, user_id[:8])
        return {"ok": True, "role_id": role_id}
    finally:
        await db.close()


@app.delete("/users/{user_id}/roles/{role_id}")
async def remove_user_role(user_id: str, role_id: str, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id FROM user_roles WHERE id = ? AND user_id = ? AND account_id = ?",
            (role_id, user_id, auth["account_id"]),
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Role not found")

        await db.execute("DELETE FROM user_roles WHERE id = ?", (role_id,))
        await db.commit()
        log.info("[ROLE] Removed role %s from user %s", role_id[:8], user_id[:8])
        return {"ok": True}
    finally:
        await db.close()


@app.get("/users/{user_id}/roles")
async def list_user_roles(user_id: str, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT ur.id as role_id, ur.account_id, ur.project_id, ur.role,
                      a.slug as account_slug, a.name as account_name,
                      p.slug as project_slug, p.name as project_name
               FROM user_roles ur
               JOIN accounts a ON ur.account_id = a.id
               JOIN projects p ON ur.project_id = p.id
               WHERE ur.user_id = ?
               ORDER BY a.name, p.name""",
            (user_id,),
        )
        return {"ok": True, "roles": [dict(r) for r in await cursor.fetchall()]}
    finally:
        await db.close()


# ── Self-service ─────────────────────────────────────────────────

@app.put("/me/password")
async def change_own_password(request: ChangePasswordRequest, auth=Depends(get_authenticated)):
    if auth.get("auth_type") != "session":
        raise HTTPException(status_code=400, detail="Password change requires session auth")
    db = await get_db()
    try:
        cursor = await db.execute("SELECT password FROM users WHERE id = ?", (auth["user_id"],))
        row = await cursor.fetchone()
        if not row or not verify_password(request.current_password, dict(row)["password"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect")
        pw_hash = hash_password(request.new_password)
        await db.execute("UPDATE users SET password = ? WHERE id = ?", (pw_hash, auth["user_id"]))
        await db.commit()
        log.info("[USER] Password changed for %s", auth["user_id"][:8])
        return {"ok": True}
    finally:
        await db.close()


# ── Account Management ───────────────────────────────────────────

@app.get("/accounts")
async def list_accounts(auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT DISTINCT a.id, a.slug, a.name, a.created_at
               FROM accounts a
               JOIN user_roles ur ON a.id = ur.account_id
               WHERE ur.user_id = ? AND ur.role = 'admin'
               ORDER BY a.name""",
            (auth["user_id"] if auth.get("auth_type") == "session" else auth["id"],),
        )
        rows = await cursor.fetchall()
        return {"ok": True, "accounts": [dict(r) for r in rows]}
    finally:
        await db.close()


@app.post("/accounts")
async def create_account(request: CreateAccountRequest, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        # Check slug uniqueness
        cursor = await db.execute("SELECT id FROM accounts WHERE slug = ?", (request.slug,))
        if await cursor.fetchone():
            raise HTTPException(status_code=409, detail=f"Account '{request.slug}' already exists")

        account_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO accounts (id, slug, name) VALUES (?, ?, ?)",
            (account_id, request.slug, request.name),
        )

        # Create default project
        project_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO projects (id, account_id, slug, name) VALUES (?, ?, ?, ?)",
            (project_id, account_id, "default", "Default Project"),
        )
        scaffold_project(request.slug, "default")

        # Assign admin role to the creator
        user_id = auth["user_id"] if auth.get("auth_type") == "session" else auth["id"]
        role_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO user_roles (id, user_id, account_id, project_id, role) VALUES (?, ?, ?, ?, ?)",
            (role_id, user_id, account_id, project_id, "admin"),
        )

        await db.commit()
        log.info("[ACCOUNT] Created '%s' by %s", request.slug, user_id[:8])
        return {"ok": True, "account_id": account_id, "project_id": project_id, "slug": request.slug}
    finally:
        await db.close()


@app.get("/accounts/{slug}")
async def get_account(slug: str, auth=Depends(require_role("admin"))):
    if auth["account_slug"] != slug:
        raise HTTPException(status_code=403, detail="Access denied to this account")
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM accounts WHERE slug = ?", (slug,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")
        return {"ok": True, "account": dict(row)}
    finally:
        await db.close()


# ── Project Management ───────────────────────────────────────────

@app.post("/accounts/{slug}/projects")
async def create_project(slug: str, request: CreateProjectRequest, auth=Depends(require_role("admin"))):
    if auth["account_slug"] != slug:
        raise HTTPException(status_code=403, detail="Access denied to this account")

    db = await get_db()
    try:
        project_id = str(uuid.uuid4())
        try:
            await db.execute(
                "INSERT INTO projects (id, account_id, slug, name) VALUES (?, ?, ?, ?)",
                (project_id, auth["account_id"], request.slug, request.name),
            )
        except Exception:
            raise HTTPException(status_code=409, detail=f"Project '{request.slug}' already exists")

        scaffold_project(slug, request.slug)

        # Auto-assign admin role to the creator for this new project
        user_id = auth["user_id"] if auth.get("auth_type") == "session" else auth["id"]
        role_id = str(uuid.uuid4())
        await db.execute(
            "INSERT OR IGNORE INTO user_roles (id, user_id, account_id, project_id, role) VALUES (?, ?, ?, ?, ?)",
            (role_id, user_id, auth["account_id"], project_id, "admin"),
        )

        await db.commit()
        log.info("[PROJECT] Created '%s/%s'", slug, request.slug)

        return {"ok": True, "project_id": project_id, "slug": request.slug, "name": request.name}
    finally:
        await db.close()


@app.get("/accounts/{slug}/projects")
async def list_projects(slug: str, auth=Depends(require_role("admin"))):
    if auth["account_slug"] != slug:
        raise HTTPException(status_code=403, detail="Access denied to this account")

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM projects WHERE account_id = ? ORDER BY created_at",
            (auth["account_id"],),
        )
        rows = await cursor.fetchall()
        return {"ok": True, "projects": [dict(r) for r in rows]}
    finally:
        await db.close()


@app.delete("/accounts/{slug}/projects/{pslug}")
async def delete_project(slug: str, pslug: str, auth=Depends(require_role("admin"))):
    if auth["account_slug"] != slug:
        raise HTTPException(status_code=403, detail="Access denied to this account")

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id FROM projects WHERE account_id = ? AND slug = ?",
            (auth["account_id"], pslug),
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Project not found")

        project_id = row["id"]
        # Clean up dependent rows before deleting the project
        await db.execute("DELETE FROM sessions WHERE project_id = ?", (project_id,))
        await db.execute("DELETE FROM user_roles WHERE project_id = ?", (project_id,))
        await db.execute("DELETE FROM access_keys WHERE project_id = ?", (project_id,))
        await db.execute("DELETE FROM approvals WHERE project_id = ?", (project_id,))
        await db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        await db.commit()

        project_dir = get_project_path(slug, pslug)
        if project_dir.exists():
            shutil.rmtree(project_dir)

        log.info("[PROJECT] Deleted '%s/%s'", slug, pslug)
        return {"ok": True, "deleted": pslug}
    finally:
        await db.close()


# ── Legacy Access Key Management (deprecated) ────────────────────

@app.post("/keys")
async def create_key(request: CreateKeyRequest, auth=Depends(require_role("admin"))):
    valid_roles = ("write-only", "read-write", "read-write-approve", "admin")
    if request.role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {valid_roles}")

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id FROM projects WHERE id = ? AND account_id = ?",
            (request.project_id, auth["account_id"]),
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Project not found in this account")

        new_key_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO access_keys (id, account_id, project_id, role, label) VALUES (?, ?, ?, ?, ?)",
            (new_key_id, auth["account_id"], request.project_id, request.role, request.label),
        )
        await db.commit()
        log.info("[KEY] Created %s key for project %s", request.role, request.project_id)

        return {"ok": True, "key": new_key_id, "role": request.role, "label": request.label}
    finally:
        await db.close()


@app.get("/keys")
async def list_keys(auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT k.id, k.role, k.label, k.created_at, k.revoked_at,
                      p.slug as project_slug, p.name as project_name
               FROM access_keys k
               JOIN projects p ON k.project_id = p.id
               WHERE k.account_id = ?
               ORDER BY k.created_at DESC""",
            (auth["account_id"],),
        )
        rows = await cursor.fetchall()
        keys = []
        for r in rows:
            d = dict(r)
            full_id = d["id"]
            d["id_masked"] = f"{full_id[:8]}...{full_id[-4:]}" if len(full_id) > 12 else full_id
            keys.append(d)
        return {"ok": True, "keys": keys}
    finally:
        await db.close()


@app.delete("/keys/{key_id}")
async def revoke_key(key_id: str, auth=Depends(require_role("admin"))):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id FROM access_keys WHERE id = ? AND account_id = ?",
            (key_id, auth["account_id"]),
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Key not found")

        await db.execute(
            "UPDATE access_keys SET revoked_at = datetime('now') WHERE id = ?",
            (key_id,),
        )
        await db.commit()
        log.info("[KEY] Revoked %s", key_id[:8])
        return {"ok": True, "revoked": key_id}
    finally:
        await db.close()


# ── Test Management ──────────────────────────────────────────────

def _tests_dir(account_slug: str, project_slug: str, status: str = "pending") -> Path:
    return get_project_path(account_slug, project_slug) / "tests" / status


def _read_meta(meta_path: Path) -> Optional[dict]:
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _list_tests_in_dir(tests_dir: Path, status: str) -> list:
    tests = []
    if not tests_dir.exists():
        return tests
    for meta_file in sorted(tests_dir.glob("*.meta.json"), reverse=True):
        meta = _read_meta(meta_file)
        if meta:
            meta["status"] = status
            tests.append(meta)
    return tests


@app.get("/tests")
async def list_tests(auth=Depends(require_role("read-write", "read-write-approve"))):
    approved = _list_tests_in_dir(
        _tests_dir(auth["account_slug"], auth["project_slug"], "approved"), "approved"
    )
    pending = _list_tests_in_dir(
        _tests_dir(auth["account_slug"], auth["project_slug"], "pending"), "pending"
    )
    return {"ok": True, "tests": pending + approved}


@app.get("/tests/{test_id}")
async def get_test(test_id: str, auth=Depends(require_role("read-write", "read-write-approve"))):
    for status in ("pending", "approved"):
        tests_dir = _tests_dir(auth["account_slug"], auth["project_slug"], status)
        for meta_file in tests_dir.glob(f"*-{test_id}.meta.json"):
            meta = _read_meta(meta_file)
            if meta and meta.get("test_id") == test_id:
                spec_file = meta_file.with_suffix("").with_suffix(".spec.ts")
                spec_code = spec_file.read_text(encoding="utf-8") if spec_file.exists() else ""
                return {
                    "ok": True,
                    "test_id": test_id,
                    "status": status,
                    "spec_code": spec_code,
                    **meta,
                }

    raise HTTPException(status_code=404, detail="Test not found")


@app.put("/tests/{test_id}")
async def update_test(test_id: str, request: UpdateTestRequest, auth=Depends(require_role("read-write", "read-write-approve"))):
    for status in ("pending", "approved"):
        tests_dir = _tests_dir(auth["account_slug"], auth["project_slug"], status)
        for meta_file in tests_dir.glob(f"*-{test_id}.meta.json"):
            meta = _read_meta(meta_file)
            if meta and meta.get("test_id") == test_id:
                spec_file = meta_file.with_suffix("").with_suffix(".spec.ts")

                # Update spec code
                if request.spec_code is not None and spec_file.exists():
                    spec_file.write_text(request.spec_code, encoding="utf-8")

                # Update metadata fields
                changed = False
                if request.test_name is not None:
                    meta["test_name"] = request.test_name
                    changed = True
                if request.target_url is not None:
                    meta["target_url"] = request.target_url
                    changed = True
                if changed:
                    meta_file.write_text(json.dumps(meta, indent=2), encoding="utf-8")

                log.info("[TEST] Updated '%s' in %s/%s (%s)", test_id, auth["account_slug"], auth["project_slug"], status)
                spec_code = spec_file.read_text(encoding="utf-8") if spec_file.exists() else ""
                return {"ok": True, "test_id": test_id, "status": status, "spec_code": spec_code, **meta}

    raise HTTPException(status_code=404, detail="Test not found")


@app.post("/tests")
async def push_test(request: PushTestRequest, auth=Depends(require_role("write-only", "read-write", "read-write-approve"))):
    import re

    test_id = str(uuid.uuid4())[:8]
    sanitized = re.sub(r"[^a-zA-Z0-9]+", "-", request.test_name.strip().lower()).strip("-")[:80] or "test"
    filename_base = f"{sanitized}-{test_id}"

    pending_dir = _tests_dir(auth["account_slug"], auth["project_slug"], "pending")
    pending_dir.mkdir(parents=True, exist_ok=True)

    spec_path = pending_dir / f"{filename_base}.spec.ts"
    spec_path.write_text(request.spec_code, encoding="utf-8")

    meta = {
        "test_id": test_id,
        "test_name": sanitized,
        "filename": f"{filename_base}.spec.ts",
        "target_url": request.target_url,
        "prompt": request.prompt,
        "status": "pending",
        "pushed_by": auth.get("user_id", auth["id"]),
        "created_at": datetime.utcnow().isoformat(),
    }
    meta_path = pending_dir / f"{filename_base}.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    log.info("[TEST] Pushed '%s' to %s/%s (pending)", sanitized, auth["account_slug"], auth["project_slug"])
    return {"ok": True, "test_id": test_id, "test_name": sanitized, "status": "pending"}


@app.post("/tests/{test_id}/approve")
async def approve_test(test_id: str, request: ApproveRejectRequest = None, auth=Depends(require_role("read-write-approve"))):
    if request is None:
        request = ApproveRejectRequest()

    pending_dir = _tests_dir(auth["account_slug"], auth["project_slug"], "pending")
    approved_dir = _tests_dir(auth["account_slug"], auth["project_slug"], "approved")
    approved_dir.mkdir(parents=True, exist_ok=True)

    for meta_file in pending_dir.glob(f"*-{test_id}.meta.json"):
        meta = _read_meta(meta_file)
        if meta and meta.get("test_id") == test_id:
            spec_file = meta_file.with_suffix("").with_suffix(".spec.ts")

            new_meta_path = approved_dir / meta_file.name
            new_spec_path = approved_dir / spec_file.name

            if spec_file.exists():
                shutil.move(str(spec_file), str(new_spec_path))
            shutil.move(str(meta_file), str(new_meta_path))

            meta["status"] = "approved"
            meta["approved_at"] = datetime.utcnow().isoformat()
            meta["approved_by"] = auth.get("user_id", auth["id"])
            new_meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

            db = await get_db()
            try:
                approver_id = auth.get("user_id", auth["id"])
                await db.execute(
                    "INSERT INTO approvals (id, project_id, test_id, action, approved_by, comment) VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), auth["project_id"], test_id, "approve", approver_id, request.comment),
                )
                await db.commit()
            finally:
                await db.close()

            log.info("[TEST] Approved '%s' in %s/%s", test_id, auth["account_slug"], auth["project_slug"])
            return {"ok": True, "test_id": test_id, "status": "approved"}

    raise HTTPException(status_code=404, detail="Test not found in pending")


@app.post("/tests/{test_id}/reject")
async def reject_test(test_id: str, request: ApproveRejectRequest = None, auth=Depends(require_role("read-write-approve"))):
    if request is None:
        request = ApproveRejectRequest()

    pending_dir = _tests_dir(auth["account_slug"], auth["project_slug"], "pending")

    for meta_file in pending_dir.glob(f"*-{test_id}.meta.json"):
        meta = _read_meta(meta_file)
        if meta and meta.get("test_id") == test_id:
            spec_file = meta_file.with_suffix("").with_suffix(".spec.ts")

            if spec_file.exists():
                spec_file.unlink()
            meta_file.unlink()

            db = await get_db()
            try:
                approver_id = auth.get("user_id", auth["id"])
                await db.execute(
                    "INSERT INTO approvals (id, project_id, test_id, action, approved_by, comment) VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), auth["project_id"], test_id, "reject", approver_id, request.comment),
                )
                await db.commit()
            finally:
                await db.close()

            log.info("[TEST] Rejected '%s' in %s/%s", test_id, auth["account_slug"], auth["project_slug"])
            return {"ok": True, "test_id": test_id, "status": "rejected"}

    raise HTTPException(status_code=404, detail="Test not found in pending")


@app.delete("/tests/{test_id}")
async def delete_test(test_id: str, auth=Depends(require_role("read-write-approve"))):
    for status in ("pending", "approved"):
        tests_dir = _tests_dir(auth["account_slug"], auth["project_slug"], status)
        for meta_file in tests_dir.glob(f"*-{test_id}.meta.json"):
            meta = _read_meta(meta_file)
            if meta and meta.get("test_id") == test_id:
                spec_file = meta_file.with_suffix("").with_suffix(".spec.ts")
                if spec_file.exists():
                    spec_file.unlink()
                meta_file.unlink()
                log.info("[TEST] Deleted '%s' from %s/%s (%s)", test_id, auth["account_slug"], auth["project_slug"], status)
                return {"ok": True, "deleted": test_id}

    raise HTTPException(status_code=404, detail="Test not found")
