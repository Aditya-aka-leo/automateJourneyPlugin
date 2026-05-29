"""Project directory scaffolding — creates a git-friendly Playwright project."""

import os
from pathlib import Path

TESTS_ROOT = Path(os.getenv("TESTS_ROOT", "/app/tests-store"))


def get_project_path(account_slug: str, project_slug: str) -> Path:
    return TESTS_ROOT / "accounts" / account_slug / "projects" / project_slug


def scaffold_project(account_slug: str, project_slug: str) -> Path:
    """Create the full directory structure for a new project."""
    project_dir = get_project_path(account_slug, project_slug)
    (project_dir / "tests" / "approved").mkdir(parents=True, exist_ok=True)
    (project_dir / "tests" / "pending").mkdir(parents=True, exist_ok=True)

    # package.json
    pkg = project_dir / "package.json"
    if not pkg.exists():
        pkg.write_text(
            f'{{\n'
            f'  "name": "{account_slug}-{project_slug}",\n'
            f'  "private": true,\n'
            f'  "scripts": {{\n'
            f'    "test": "npx playwright test",\n'
            f'    "test:pending": "npx playwright test --config=playwright.pending.config.ts"\n'
            f'  }},\n'
            f'  "devDependencies": {{\n'
            f'    "@playwright/test": "^1.45.0"\n'
            f'  }}\n'
            f'}}\n',
            encoding="utf-8",
        )

    # playwright.config.ts (approved)
    cfg = project_dir / "playwright.config.ts"
    if not cfg.exists():
        cfg.write_text(
            "import { defineConfig } from '@playwright/test';\n"
            "export default defineConfig({\n"
            "  testDir: './tests/approved',\n"
            "  use: { headless: true },\n"
            "});\n",
            encoding="utf-8",
        )

    # playwright.pending.config.ts
    pcfg = project_dir / "playwright.pending.config.ts"
    if not pcfg.exists():
        pcfg.write_text(
            "import { defineConfig } from '@playwright/test';\n"
            "export default defineConfig({\n"
            "  testDir: './tests/pending',\n"
            "  use: { headless: true },\n"
            "});\n",
            encoding="utf-8",
        )

    # .gitignore
    gi = project_dir / ".gitignore"
    if not gi.exists():
        gi.write_text(
            "node_modules/\n"
            "test-results/\n"
            "playwright-report/\n"
            "blob-report/\n"
            ".DS_Store\n",
            encoding="utf-8",
        )

    return project_dir
