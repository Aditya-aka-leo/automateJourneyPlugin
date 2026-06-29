"""
Test Aggregator — pulls Playwright spec files from external sources into tests-store.

Endpoints:
  GET  /health                  → health check
  POST /aggregate               → clone/pull a git repo and copy specs into tests-store
  GET  /sources                 → list all registered sources
  GET  /sources/{source_id}     → get a single source + its specs
  POST /sources/{source_id}/sync → re-pull latest from a registered source
  DELETE /sources/{source_id}   → remove a source and its specs
  GET  /specs                   → list all spec files across all sources
"""

import json
import logging
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import git
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("aggregator")

TESTS_STORE_ROOT = Path(os.getenv("TESTS_STORE_ROOT", "/app/tests-store"))
SOURCES_STORE = Path(os.getenv("SOURCES_STORE", "/app/sources-store"))
CLONE_ROOT = Path("/tmp/aggregator-clones")

TESTS_STORE_ROOT.mkdir(parents=True, exist_ok=True)
SOURCES_STORE.mkdir(parents=True, exist_ok=True)
CLONE_ROOT.mkdir(parents=True, exist_ok=True)

SOURCES_DB = SOURCES_STORE / "sources.json"


# ── Pydantic models ───────────────────────────────────────────────

class AggregateRequest(BaseModel):
    repo_url: str
    branch: str = "main"
    subdirectory: Optional[str] = None  # only copy specs from this subdir
    name: Optional[str] = None          # friendly label; defaults to repo name

    @field_validator("repo_url")
    @classmethod
    def validate_repo_url(cls, v: str) -> str:
        v = v.strip()
        if not re.match(r"^https?://|^git@", v):
            raise ValueError("repo_url must start with https:// or git@")
        return v


class SourceRecord(BaseModel):
    source_id: str
    name: str
    repo_url: str
    branch: str
    subdirectory: Optional[str]
    specs_dir: str          # path inside tests-store where specs live
    spec_files: list[str]   # relative paths within specs_dir
    synced_at: str
    commit_sha: str


class SyncResponse(BaseModel):
    ok: bool
    source: SourceRecord
    added: int
    removed: int


# ── Persistence helpers ───────────────────────────────────────────

def _load_sources() -> dict[str, dict]:
    if not SOURCES_DB.exists():
        return {}
    try:
        return json.loads(SOURCES_DB.read_text())
    except Exception:
        return {}


def _save_sources(sources: dict[str, dict]) -> None:
    SOURCES_DB.write_text(json.dumps(sources, indent=2))


# ── Core clone + copy logic ───────────────────────────────────────

def _repo_name_from_url(url: str) -> str:
    name = url.rstrip("/").split("/")[-1]
    return re.sub(r"\.git$", "", name)


def _clone_or_pull(repo_url: str, branch: str, clone_dir: Path) -> git.Repo:
    if (clone_dir / ".git").exists():
        log.info("Pulling latest for %s", repo_url)
        repo = git.Repo(clone_dir)
        origin = repo.remotes.origin
        origin.fetch()
        repo.git.checkout(branch)
        repo.git.pull("origin", branch)
    else:
        log.info("Cloning %s (branch=%s) → %s", repo_url, branch, clone_dir)
        repo = git.Repo.clone_from(repo_url, clone_dir, branch=branch, depth=1)
    return repo


def _collect_specs(search_root: Path) -> list[Path]:
    patterns = ["**/*.spec.ts", "**/*.spec.js", "**/*.test.ts", "**/*.test.js"]
    found: list[Path] = []
    seen = set()
    for pattern in patterns:
        for p in search_root.glob(pattern):
            if p not in seen:
                found.append(p)
                seen.add(p)
    return sorted(found)


def _copy_specs_to_store(
    specs: list[Path],
    search_root: Path,
    dest_dir: Path,
) -> list[str]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    relative_names: list[str] = []
    for spec in specs:
        rel = spec.relative_to(search_root)
        target = dest_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(spec, target)
        relative_names.append(str(rel))
        log.info("Copied spec: %s", rel)
    return relative_names


def _also_copy_config(clone_dir: Path, dest_dir: Path) -> None:
    for config_name in ["playwright.config.ts", "playwright.config.js", "package.json"]:
        src = clone_dir / config_name
        if src.exists():
            shutil.copy2(src, dest_dir / config_name)
            log.info("Copied config: %s", config_name)


def _do_aggregate(req: AggregateRequest) -> SyncResponse:
    source_name = req.name or _repo_name_from_url(req.repo_url)
    source_id = re.sub(r"[^a-z0-9\-]", "-", source_name.lower())[:40]

    sources = _load_sources()

    # Re-use existing source_id if this URL was already registered
    for sid, rec in sources.items():
        if rec["repo_url"] == req.repo_url and rec["branch"] == req.branch:
            source_id = sid
            break

    clone_dir = CLONE_ROOT / source_id
    repo = _clone_or_pull(req.repo_url, req.branch, clone_dir)
    commit_sha = repo.head.commit.hexsha[:12]

    search_root = clone_dir
    if req.subdirectory:
        search_root = clone_dir / req.subdirectory
        if not search_root.exists():
            raise HTTPException(status_code=400, detail=f"subdirectory '{req.subdirectory}' not found in repo")

    specs = _collect_specs(search_root)
    if not specs:
        raise HTTPException(status_code=404, detail="No *.spec.ts / *.test.ts files found in repo")

    dest_dir = TESTS_STORE_ROOT / "aggregated" / source_id
    old_specs = set(str(p.relative_to(dest_dir)) for p in dest_dir.rglob("*.spec.*")) if dest_dir.exists() else set()

    spec_names = _copy_specs_to_store(specs, search_root, dest_dir)
    _also_copy_config(clone_dir, dest_dir)

    new_specs = set(spec_names)
    added = len(new_specs - old_specs)
    removed = len(old_specs - new_specs)

    record = SourceRecord(
        source_id=source_id,
        name=source_name,
        repo_url=req.repo_url,
        branch=req.branch,
        subdirectory=req.subdirectory,
        specs_dir=str(dest_dir),
        spec_files=spec_names,
        synced_at=datetime.now(timezone.utc).isoformat(),
        commit_sha=commit_sha,
    )
    sources[source_id] = record.model_dump()
    _save_sources(sources)

    log.info("Aggregated %d specs from %s (sha=%s)", len(spec_names), req.repo_url, commit_sha)
    return SyncResponse(ok=True, source=record, added=added, removed=removed)


# ── FastAPI app ───────────────────────────────────────────────────

app = FastAPI(title="Test Aggregator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    sources = _load_sources()
    return {
        "status": "healthy",
        "sources_count": len(sources),
        "tests_store": str(TESTS_STORE_ROOT),
    }


@app.post("/aggregate", response_model=SyncResponse)
def aggregate(req: AggregateRequest):
    """Clone a git repo and copy all Playwright spec files into tests-store."""
    try:
        return _do_aggregate(req)
    except HTTPException:
        raise
    except git.exc.GitCommandError as e:
        raise HTTPException(status_code=422, detail=f"Git error: {e.stderr.strip()}")
    except Exception as e:
        log.exception("Aggregate failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sources")
def list_sources():
    """List all registered sources and their spec file counts."""
    sources = _load_sources()
    return {
        "sources": list(sources.values()),
        "total": len(sources),
    }


@app.get("/sources/{source_id}")
def get_source(source_id: str):
    """Get a single source record with full spec file list."""
    sources = _load_sources()
    if source_id not in sources:
        raise HTTPException(status_code=404, detail="Source not found")
    return sources[source_id]


@app.post("/sources/{source_id}/sync", response_model=SyncResponse)
def sync_source(source_id: str):
    """Re-pull latest commits for an already-registered source."""
    sources = _load_sources()
    if source_id not in sources:
        raise HTTPException(status_code=404, detail="Source not found")
    rec = sources[source_id]
    req = AggregateRequest(
        repo_url=rec["repo_url"],
        branch=rec["branch"],
        subdirectory=rec.get("subdirectory"),
        name=rec["name"],
    )
    try:
        return _do_aggregate(req)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Sync failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/sources/{source_id}")
def delete_source(source_id: str):
    """Remove a source and delete its spec files from tests-store."""
    sources = _load_sources()
    if source_id not in sources:
        raise HTTPException(status_code=404, detail="Source not found")

    rec = sources[source_id]
    dest_dir = Path(rec["specs_dir"])
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
        log.info("Deleted specs dir: %s", dest_dir)

    clone_dir = CLONE_ROOT / source_id
    if clone_dir.exists():
        shutil.rmtree(clone_dir)

    del sources[source_id]
    _save_sources(sources)
    return {"ok": True, "deleted": source_id}


@app.get("/specs")
def list_specs():
    """List all spec files currently in tests-store/aggregated/, grouped by source."""
    sources = _load_sources()
    result = []
    for source_id, rec in sources.items():
        result.append({
            "source_id": source_id,
            "name": rec["name"],
            "repo_url": rec["repo_url"],
            "synced_at": rec["synced_at"],
            "specs": [
                {
                    "file": f,
                    "path": str(Path(rec["specs_dir"]) / f),
                }
                for f in rec.get("spec_files", [])
            ],
        })
    return {"sources": result, "total_specs": sum(len(r["specs"]) for r in result)}


@app.on_event("startup")
def startup():
    log.info("Test Aggregator started")
    log.info("  tests-store → %s", TESTS_STORE_ROOT)
    log.info("  sources-db  → %s", SOURCES_DB)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8005)
