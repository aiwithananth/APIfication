"""Shared control-plane services used by routers, the gateway and the AI layer."""
from __future__ import annotations

import hashlib
import re
import secrets
import time
from collections import defaultdict
from typing import Any

from . import db
from .config import ORG_ID
from .ir.validator import digest, validate
from .runtime.policy import Principal

ENVIRONMENTS = ["development", "staging", "production"]

# --------------------------------------------------------------------------- users (dev-mode identity)
# Production deployments federate identity through OIDC/SAML (Keycloak or the customer IdP).
CURRENT_USER = {"id": "usr_admin", "name": "Platform Admin", "email": "admin@apification.local",
                "roles": ["org_admin", "security_admin", "api_designer", "release_approver", "operator", "auditor"]}


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "item"


# --------------------------------------------------------------------------- lookups

def connectors_map() -> dict[str, dict]:
    return {c["id"]: c for c in db.list_records("connector", ORG_ID)}


def project_by_slug(slug: str) -> dict | None:
    return next((p for p in db.list_records("project", ORG_ID) if p.get("slug") == slug), None)


def latest_revision(capability_id: str) -> dict | None:
    revs = db.list_revisions(capability_id)
    return revs[0] if revs else None


def save_revision(capability: dict, spec: dict, *, author: str, summary: str) -> dict:
    """Store a new immutable revision after deterministic validation."""
    v = validate(spec, connectors_map())
    parent = latest_revision(capability["id"])
    rev = db.add_revision(capability["id"], spec, status="validated" if v["valid"] else "draft",
                          digest=digest(spec), author=author, summary=summary, validation=v,
                          parent_id=parent["id"] if parent else None)
    capability = {**capability, "latest_revision_id": rev["id"], "latest_revision": rev["number"],
                  "name": spec["capability"]["name"], "description": spec["capability"].get("description", ""),
                  "valid": v["valid"]}
    db.put_record("capability", ORG_ID, capability, project_id=capability["project_id"])
    db.audit(ORG_ID, author, "capability.revision.create", resource=f"{capability['id']}@{rev['number']}",
             project_id=capability["project_id"], details={"summary": summary, "valid": v["valid"], "digest": rev["digest"]})
    return rev


def deployed_specs(project_id: str, environment: str) -> list[tuple[dict, dict]]:
    """[(capability, revision)] for active deployments of a project in an environment."""
    out = []
    for d in db.list_records("deployment", ORG_ID, project_id=project_id):
        if d.get("environment") == environment and d.get("status") == "active":
            rev = db.get_revision(d["revision_id"])
            cap = db.get_record("capability", d["capability_id"])
            if rev and cap:
                out.append((cap, rev))
    return out


def find_operation(project_id: str, environment: str, capability_id: str, operation_id: str):
    for cap, rev in deployed_specs(project_id, environment):
        if cap["id"] == capability_id:
            op = next((o for o in rev["spec"]["operations"] if o["id"] == operation_id), None)
            if op:
                return cap, rev, op
    return None


# --------------------------------------------------------------------------- api clients / tokens

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(client: dict, token: str | None = None) -> tuple[dict, str]:
    token = token or "apf_" + secrets.token_urlsafe(24)
    client = {**client, "token_hash": hash_token(token), "token_prefix": token[:10], "token_issued_at": time.time()}
    return client, token


def _console_key() -> bytes:
    from .config import DATA_DIR
    f = DATA_DIR / "console.key"
    if not f.exists():
        f.write_bytes(secrets.token_bytes(32))
    return f.read_bytes()


def mint_console_token(client_id: str, ttl_s: int = 600) -> str:
    """Short-lived token for a platform user testing as an API client (token exchange)."""
    import base64
    import hmac
    exp = int(time.time()) + ttl_s
    payload = f"{client_id}.{exp}"
    sig = hmac.new(_console_key(), payload.encode(), hashlib.sha256).digest()
    return "apfc_" + base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=") + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")


def _verify_console_token(token: str) -> str | None:
    import base64
    import hmac
    try:
        p, s = token[5:].split(".")
        payload = base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)).decode()
        sig = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        if not hmac.compare_digest(sig, hmac.new(_console_key(), payload.encode(), hashlib.sha256).digest()):
            return None
        cid, exp = payload.rsplit(".", 1)
        return cid if int(exp) > time.time() else None
    except (ValueError, UnicodeDecodeError):
        return None


def client_by_token(token: str) -> dict | None:
    if token.startswith("apfc_"):
        cid = _verify_console_token(token)
        c = db.get_record("api_client", cid) if cid else None
        return c if c and c.get("status", "active") == "active" else None
    h = hash_token(token)
    return next((c for c in db.list_records("api_client", ORG_ID) if c.get("token_hash") == h and c.get("status", "active") == "active"), None)


def principal_for(client: dict) -> Principal:
    return Principal(subject=client.get("subject") or client["id"], kind=client.get("kind", "application"),
                     roles=client.get("roles", []), scopes=client.get("scopes", []), tenant=client.get("tenant"),
                     client_id=client["id"], client_name=client.get("name"))


def public_client(c: dict) -> dict:
    return {k: v for k, v in c.items() if k != "token_hash"}


# --------------------------------------------------------------------------- rate limiting

class RateLimiter:
    def __init__(self) -> None:
        self.hits: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str, per_minute: int) -> bool:
        now = time.time()
        window = [t for t in self.hits[key] if now - t < 60]
        if len(window) >= per_minute:
            self.hits[key] = window
            return False
        window.append(now)
        self.hits[key] = window
        return True


rate_limiter = RateLimiter()


def overview() -> dict[str, Any]:
    kinds = ["project", "capability", "connector", "mcp_server", "deployment", "approval", "api_client",
             "model_provider", "agent", "test_run"]
    data = db.iter_kinds(ORG_ID, kinds)
    traces = db.list_traces(ORG_ID, limit=500)
    denials = [t for t in traces if t["status"] in (401, 403)]
    lat = sorted(t["duration_ms"] for t in traces) or [0]

    def pct(p):
        return lat[min(len(lat) - 1, int(len(lat) * p))]
    ops = 0
    rest = gql = mcp = 0
    for cap in data["capability"]:
        rev = db.get_revision(cap.get("latest_revision_id", "")) if cap.get("latest_revision_id") else None
        if rev:
            for o in rev["spec"]["operations"]:
                ops += 1
                kinds_ = {i["kind"] for i in o["interfaces"] if i.get("enabled", True)}
                rest += "rest" in kinds_
                gql += "graphql" in kinds_
                mcp += "mcp" in kinds_
    by_iface: dict[str, int] = defaultdict(int)
    for t in traces:
        by_iface[t["interface"]] += 1
    return {
        "counts": {k: len(v) for k, v in data.items()},
        "operations": ops, "rest_operations": rest, "graphql_fields": gql, "mcp_tools": mcp,
        "active_deployments": [d for d in data["deployment"] if d.get("status") == "active"],
        "pending_approvals": [a for a in data["approval"] if a.get("status") == "pending"],
        "connector_health": [{"id": c["id"], "name": c["name"], "type": c["type"], "status": c.get("health", "unknown"),
                              "read_only": c.get("read_only", True)} for c in data["connector"]],
        "requests": len(traces), "denials": len(denials),
        "errors": len([t for t in traces if t["status"] >= 500]),
        "latency": {"p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99)},
        "by_interface": by_iface,
        "recent_traces": traces[:8],
        "last_test_runs": sorted(data["test_run"], key=lambda r: r.get("created_at", ""), reverse=True)[:5],
    }
