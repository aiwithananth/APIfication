"""Runtime configuration for the control plane.

Everything is driven by environment variables so the same build runs in
local development, SaaS and self-hosted deployments.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("APF_DATA_DIR", BASE_DIR / ".data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Platform registry. SQLite for local development, PostgreSQL in production:
#   APF_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/apification
DATABASE_URL = os.getenv("APF_DATABASE_URL", f"sqlite:///{DATA_DIR / 'registry.db'}")

# Local vault master key file (development only). In production, replace the
# vault backend with Vault/OpenBao or a cloud secret manager.
VAULT_KEY_FILE = Path(os.getenv("APF_VAULT_KEY_FILE", DATA_DIR / "vault.key"))
VAULT_FILE = Path(os.getenv("APF_VAULT_FILE", DATA_DIR / "vault.json"))

# Demo database used by the seeded "Customer Service" project.
DEMO_DB_PATH = Path(os.getenv("APF_DEMO_DB", DATA_DIR / "demo_crm.sqlite"))

ORG_ID = os.getenv("APF_ORG_ID", "org_default")
SEED_DEMO = os.getenv("APF_SEED_DEMO", "1") == "1"

CORS_ORIGINS = [o.strip() for o in os.getenv("APF_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]

# Outbound HTTP allowlist for http.request nodes and custom model endpoints.
# Comma-separated host names. "*" disables the check (development only).
EGRESS_ALLOWLIST = [h.strip() for h in os.getenv("APF_EGRESS_ALLOWLIST", "*").split(",") if h.strip()]

PLATFORM_VERSION = "0.1.0"
