"""Model Provider Hub, Agentic Workspace and the in-app assistant."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from .. import db
from ..ai import assistant
from ..ai import llm
from ..ai.agents import DEFAULT_AGENTS
from ..config import ORG_ID
from ..models import AgentIn, ChatRequest, ProviderIn
from ..services import CURRENT_USER
from ..vault import vault

router = APIRouter(prefix="/v1", tags=["ai"])
USER = CURRENT_USER["name"]

PROVIDER_PRESETS = [
    {"provider_type": "anthropic", "label": "Anthropic", "base_url": "https://api.anthropic.com", "model_hint": "claude-sonnet-5-5"},
    {"provider_type": "openai", "label": "OpenAI", "base_url": "https://api.openai.com/v1", "model_hint": "gpt-4.1"},
    {"provider_type": "azure_openai", "label": "Azure OpenAI", "base_url": "https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-10-21", "model_hint": "deployment name"},
    {"provider_type": "ollama", "label": "Ollama (local)", "base_url": "http://localhost:11434/v1", "model_hint": "llama3.1"},
    {"provider_type": "openai_compatible", "label": "OpenAI-compatible gateway", "base_url": "https://gateway.example.com/v1", "model_hint": "model id"},
]


def pub(p: dict) -> dict:
    out = {k: v for k, v in p.items() if k not in ("secret_ref",)}
    out["has_key"] = bool(p.get("secret_ref"))
    out["headers"] = {k: "••••" for k in (p.get("headers") or {})}
    return out


@router.get("/model-providers/presets")
def presets():
    return PROVIDER_PRESETS


@router.get("/model-providers")
def list_providers():
    return [pub(p) for p in db.list_records("model_provider", ORG_ID)]


def _set_default(pid: str) -> None:
    for p in db.list_records("model_provider", ORG_ID):
        if p.get("is_default") and p["id"] != pid:
            p["is_default"] = False
            db.put_record("model_provider", ORG_ID, p)


@router.post("/model-providers")
def create_provider(body: ProviderIn):
    data = body.model_dump(exclude={"api_key"})
    if body.api_key:
        data["secret_ref"] = vault.put(body.api_key, label=f"provider:{body.name}", owner=USER)
    data.update({"status": "active", "tested_capabilities": [], "health": "untested"})
    p = db.put_record("model_provider", ORG_ID, data, id=db.new_id("prov"))
    if body.is_default:
        _set_default(p["id"])
    db.audit(ORG_ID, USER, "model_provider.create", resource=p["id"], details={"type": body.provider_type, "model": body.model})
    return pub(p)


@router.patch("/model-providers/{pid}")
def patch_provider(pid: str, body: dict = Body(...)):
    p = db.get_record("model_provider", pid)
    if not p:
        raise HTTPException(404, "Provider not found")
    for k in ("name", "base_url", "model", "region", "data_classification_max", "timeout_s", "max_tokens", "enabled_projects",
              "status", "is_default"):
        if k in body:
            p[k] = body[k]
    if body.get("api_key"):
        if p.get("secret_ref"):
            vault.delete(p["secret_ref"])
        p["secret_ref"] = vault.put(body["api_key"], label=f"provider:{p['name']}", owner=USER)
        db.audit(ORG_ID, USER, "model_provider.key.rotate", resource=pid)
    if body.get("headers"):
        p["headers"] = body["headers"]
    if body.get("is_default"):
        _set_default(pid)
    db.audit(ORG_ID, USER, "model_provider.update", resource=pid)
    return pub(db.put_record("model_provider", ORG_ID, p))


@router.delete("/model-providers/{pid}")
def delete_provider(pid: str):
    p = db.get_record("model_provider", pid)
    if not p:
        raise HTTPException(404, "Provider not found")
    if p.get("provider_type") == "builtin":
        raise HTTPException(409, "The built-in engine cannot be removed")
    if p.get("secret_ref"):
        vault.delete(p["secret_ref"])
    db.delete_record("model_provider", pid)
    db.audit(ORG_ID, USER, "model_provider.delete", resource=pid)
    return {"ok": True}


@router.post("/model-providers/{pid}/test")
def test_prov(pid: str):
    p = db.get_record("model_provider", pid)
    if not p:
        raise HTTPException(404, "Provider not found")
    r = llm.test_provider(p)
    p["health"] = "healthy" if r["ok"] else "failing"
    p["tested_capabilities"] = r["capabilities"]
    p["last_test"] = r
    db.put_record("model_provider", ORG_ID, p)
    db.audit(ORG_ID, USER, "model_provider.test", resource=pid, outcome="success" if r["ok"] else "failure")
    return r


# --------------------------------------------------------------------------- agents

@router.get("/agents")
def list_agents():
    return sorted(db.list_records("agent", ORG_ID), key=lambda a: a.get("order", 100))


@router.patch("/agents/{aid}")
def patch_agent(aid: str, body: dict = Body(...)):
    a = db.get_record("agent", aid)
    if not a:
        raise HTTPException(404, "Agent not found")
    if a.get("mandatory") and body.get("enabled") is False:
        raise HTTPException(409, f"{a['name']} is a mandatory stage and cannot be disabled")
    changed = False
    for k in ("system_prompt", "provider_id", "temperature", "tools", "max_turns", "token_budget", "enabled", "approval_required", "purpose"):
        if k in body and body[k] != a.get(k):
            a[k] = body[k]
            changed = True
    if changed:
        a["version"] = int(a.get("version", 1)) + 1
        a.setdefault("history", []).append({"version": a["version"], "by": USER,
                                            "changes": [k for k in body if k in a]})
        a["history"] = a["history"][-20:]
    db.audit(ORG_ID, USER, "agent.update", resource=aid, details={"version": a.get("version")})
    return db.put_record("agent", ORG_ID, a)


@router.post("/agents")
def create_agent(body: AgentIn):
    a = db.put_record("agent", ORG_ID, {**body.model_dump(), "key": body.name.lower().replace(" ", "_"), "version": 1,
                                        "identity": f"agent:{body.name.lower().replace(' ', '-')}"}, id=db.new_id("agt"))
    db.audit(ORG_ID, USER, "agent.create", resource=a["id"])
    return a


@router.get("/agent-runs")
def agent_runs(project_id: str | None = None):
    return sorted(db.list_records("agent_run", ORG_ID, project_id=project_id), key=lambda r: r["created_at"], reverse=True)


@router.get("/agent-runs/{rid}")
def agent_run(rid: str):
    r = db.get_record("agent_run", rid)
    if not r:
        raise HTTPException(404, "Run not found")
    return r


def default_agent_records() -> list[dict]:
    out = []
    for a in DEFAULT_AGENTS:
        out.append({"name": a["name"], "key": a["key"], "role": a["role"], "purpose": a["purpose"], "order": a["order"],
                    "system_prompt": "", "provider_id": None, "temperature": 0.2, "tools": a["tools"],
                    "max_turns": 6, "token_budget": 16000, "enabled": a.get("enabled", True),
                    "mandatory": a.get("mandatory", False), "version": 1, "identity": f"agent:{a['key']}"})
    out.append({"name": "Assistant", "key": "assistant", "role": "In-app assistant", "order": 5,
                "purpose": "Answers questions about the platform and acts for the signed-in user.",
                "system_prompt": "", "provider_id": None, "temperature": 0.2,
                "tools": [t["name"] for t in assistant.TOOLS], "max_turns": 6, "token_budget": 16000,
                "enabled": True, "mandatory": False, "version": 1, "identity": "agent:assistant"})
    return out


# --------------------------------------------------------------------------- assistant

@router.post("/assistant/chat")
def chat(body: ChatRequest):
    msgs = [m.model_dump() for m in body.messages]
    r = assistant.chat(msgs, body.context)
    db.audit(ORG_ID, USER, "assistant.chat", actor_type="user", details={"tools": r.get("tools_used", []), "engine": r.get("engine")})
    return r


@router.get("/assistant/suggestions")
def suggestions(page: str = "/"):
    base = {
        "/": ["Show platform status", "What should I build first?", "How do approvals work?"],
        "/build": ["Create a customer API using the Demo CRM database with REST, GraphQL and read-only MCP tools",
                   "What should a good prompt include?"],
        "/connectors": ["How do I connect PostgreSQL?", "What does read-only mean for connectors?"],
        "/security": ["How do scopes differ from roles?", "How does tenant isolation work?"],
        "/mcp": ["How do I connect an MCP client?", "Why are MCP tools read-only?"],
        "/agents": ["Which agents are mandatory?", "How do I assign a model to an agent?"],
        "/deployments": ["What are the promotion gates?", "How do I roll back?"],
    }
    if page.startswith("/capabilities/"):
        return ["Why is my capability invalid?", "Run tests", "Deploy to development"]
    return base.get(page, ["Show platform status", "How do I create an API?", "List capabilities"])
