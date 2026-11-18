"""In-app assistant ("Copilot").

Answers questions about the platform and performs bounded actions through the
same management services the UI uses. With an external model it runs a
tool-calling loop; without one, a deterministic intent engine + document
search answers.

The assistant acts as the signed-in user, inside the same governance rules:
it can deploy to development but cannot approve or promote to staging/production.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Callable

from .. import db
from ..config import BASE_DIR, ORG_ID
from ..services import CURRENT_USER, overview
from . import llm

KB_DIR = Path(__file__).parent / "kb"
ARCH_DOC = next((p for p in [BASE_DIR.parent.parent / "docs" / "architecture" / "platform-architecture.md",
                              BASE_DIR / "docs" / "architecture" / "platform-architecture.md"] if p.exists()),
                BASE_DIR / "docs" / "architecture" / "platform-architecture.md")

ROUTES = {
    "overview": "/", "dashboard": "/", "home": "/", "projects": "/projects", "builder": "/build", "api builder": "/build",
    "connectors": "/connectors", "database": "/connectors", "graphql": "/graphql", "mcp": "/mcp",
    "agents": "/agents", "agentic": "/agents", "security": "/security", "policies": "/security", "clients": "/security?tab=clients",
    "tests": "/testing", "testing": "/testing", "deployments": "/deployments", "approvals": "/approvals",
    "monitoring": "/monitoring", "audit": "/monitoring?tab=audit", "traces": "/monitoring", "portal": "/portal",
    "settings": "/settings", "providers": "/settings/providers", "models": "/settings/providers", "capabilities": "/capabilities",
}


# --------------------------------------------------------------------------- knowledge base

class KB:
    def __init__(self) -> None:
        self.chunks: list[dict] = []
        files = sorted(KB_DIR.glob("*.md"))
        if ARCH_DOC.exists():
            files.append(ARCH_DOC)
        for f in files:
            self._load(f)
        self.df = Counter()
        for c in self.chunks:
            self.df.update(set(c["tokens"]))

    def _load(self, path: Path) -> None:
        source = "Product guide" if path.parent == KB_DIR else "Architecture specification"
        title, buf = path.stem, []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("#"):
                self._add(source, title, buf)
                title, buf = line.lstrip("# ").strip(), []
            else:
                buf.append(line)
        self._add(source, title, buf)

    def _add(self, source: str, title: str, lines: list[str]) -> None:
        text = "\n".join(lines).strip()
        if len(text) < 160:
            return
        self.chunks.append({"source": source, "title": title, "text": text, "tokens": tok(title + " " + title + " " + text)})

    def search(self, query: str, k: int = 4) -> list[dict]:
        q = tok(query)
        if not q:
            return []
        n = len(self.chunks)
        scored = []
        for c in self.chunks:
            tf = Counter(c["tokens"])
            s = sum((tf[t] / (1 + 0.02 * len(c["tokens"]))) * math.log(1 + n / (1 + self.df[t])) for t in q if t in tf)
            if c["source"] == "Product guide":
                s *= 1.6
            if s > 0:
                scored.append((s, c))
        scored.sort(key=lambda x: -x[0])
        return [{"source": c["source"], "title": c["title"], "text": c["text"], "score": round(s, 3)} for s, c in scored[:k]]


STOP = set("a an the of to and or in on for with is are be can i do how what why where which my me it this that you your we our".split())


def tok(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9:_]+", s.lower()) if w not in STOP and len(w) > 1]


_kb: KB | None = None


def kb() -> KB:
    global _kb
    if _kb is None:
        _kb = KB()
    return _kb


# --------------------------------------------------------------------------- tools

def _projects() -> list[dict]:
    return db.list_records("project", ORG_ID)


def _resolve_project(pid: str | None) -> dict | None:
    ps = _projects()
    if pid:
        for p in ps:
            if pid in (p["id"], p.get("slug"), p["name"]) or pid.lower() == p["name"].lower():
                return p
    return ps[0] if ps else None


def t_search_docs(query: str) -> dict:
    return {"results": [{"title": r["title"], "source": r["source"], "text": r["text"][:1200]} for r in kb().search(query, 4)]}


def t_status() -> dict:
    o = overview()
    return {"counts": o["counts"], "operations": o["operations"], "requests": o["requests"], "denials": o["denials"],
            "errors": o["errors"], "latency_ms": o["latency"], "pending_approvals": len(o["pending_approvals"]),
            "active_deployments": [{"capability": d.get("capability_name"), "environment": d["environment"],
                                    "revision": d.get("revision_number")} for d in o["active_deployments"]],
            "connectors": o["connector_health"]}


def t_list(kind: str, project_id: str | None = None) -> dict:
    kinds = {"projects": "project", "capabilities": "capability", "connectors": "connector", "mcp_servers": "mcp_server",
             "api_clients": "api_client", "deployments": "deployment", "approvals": "approval", "providers": "model_provider",
             "agents": "agent", "test_runs": "test_run"}
    k = kinds.get(kind, kind)
    recs = db.list_records(k, ORG_ID, project_id=project_id if k not in ("connector", "model_provider", "agent") else None)
    keep = ("id", "name", "slug", "type", "status", "environment", "project_id", "kind", "scopes", "roles", "valid",
            "latest_revision", "read_only", "health", "provider_type", "model", "passed", "total", "capability_name")
    return {"items": [{k2: r[k2] for k2 in keep if k2 in r} for r in recs][:50]}


def t_get_capability(capability_id: str) -> dict:
    cap = db.get_record("capability", capability_id) or next(
        (c for c in db.list_records("capability", ORG_ID) if c["name"].lower() == capability_id.lower()), None)
    if not cap:
        return {"error": "capability not found"}
    rev = db.get_revision(cap.get("latest_revision_id", ""))
    spec = rev["spec"] if rev else {}
    return {"id": cap["id"], "name": cap["name"], "revision": rev["number"] if rev else None,
            "status": rev["status"] if rev else None, "validation": rev["validation"] if rev else None,
            "operations": [{"id": o["id"], "name": o["name"], "side_effect": o["side_effect"], "scopes": o["required_scopes"],
                            "interfaces": [i["kind"] for i in o["interfaces"]], "approval_required": o.get("approval_required")}
                           for o in spec.get("operations", [])],
            "roles": spec.get("roles"), "assumptions": spec.get("assumptions"), "questions": spec.get("questions"),
            "link": f"/capabilities/{cap['id']}"}


class Actions:
    """Late-bound action implementations provided by the routers (avoids import cycles)."""
    create_project: Callable[..., dict]
    generate_capability: Callable[..., dict]
    run_tests: Callable[..., dict]
    deploy: Callable[..., dict]
    simulate: Callable[..., dict]


actions = Actions()

TOOLS = [
    {"name": "search_docs", "description": "Search the product guide and architecture specification.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "get_platform_status", "description": "Counts, traffic, denials, latency, deployments and connector health.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "list_resources", "description": "List platform resources of a kind.",
     "parameters": {"type": "object", "properties": {
         "kind": {"type": "string", "enum": ["projects", "capabilities", "connectors", "mcp_servers", "api_clients", "deployments",
                                              "approvals", "providers", "agents", "test_runs"]},
         "project_id": {"type": "string"}}, "required": ["kind"]}},
    {"name": "get_capability", "description": "Details, operations and validation results of a capability.",
     "parameters": {"type": "object", "properties": {"capability_id": {"type": "string"}}, "required": ["capability_id"]}},
    {"name": "create_project", "description": "Create a new project.",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "description": {"type": "string"}}, "required": ["name"]}},
    {"name": "generate_capability", "description": "Generate and save a capability (APIs, workflow, policies, tests) from a natural-language requirement.",
     "parameters": {"type": "object", "properties": {"prompt": {"type": "string"}, "project_id": {"type": "string"},
                                                     "connector_id": {"type": "string"}}, "required": ["prompt"]}},
    {"name": "run_tests", "description": "Run the generated test suite for a capability's latest revision.",
     "parameters": {"type": "object", "properties": {"capability_id": {"type": "string"}}, "required": ["capability_id"]}},
    {"name": "deploy_to_development", "description": "Deploy a capability's latest validated revision to development. Staging and production need a person.",
     "parameters": {"type": "object", "properties": {"capability_id": {"type": "string"}}, "required": ["capability_id"]}},
    {"name": "simulate_policy", "description": "Check whether roles/scopes/tenant would be allowed to call an operation.",
     "parameters": {"type": "object", "properties": {"capability_id": {"type": "string"}, "operation_id": {"type": "string"},
                                                     "roles": {"type": "array", "items": {"type": "string"}},
                                                     "scopes": {"type": "array", "items": {"type": "string"}},
                                                     "environment": {"type": "string"}},
                    "required": ["capability_id", "operation_id"]}},
    {"name": "navigate", "description": "Open a page in the app for the user.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "App path, e.g. /connectors"},
                                                     "label": {"type": "string"}}, "required": ["path"]}},
]


def call_tool(name: str, args: dict, ui_actions: list[dict], ctx: dict) -> Any:
    if name == "search_docs":
        return t_search_docs(args.get("query", ""))
    if name == "get_platform_status":
        return t_status()
    if name == "list_resources":
        return t_list(args.get("kind", "projects"), args.get("project_id"))
    if name == "get_capability":
        r = t_get_capability(args.get("capability_id", ""))
        return r
    if name == "create_project":
        p = actions.create_project(args["name"], args.get("description", ""))
        ui_actions.append({"type": "navigate", "path": f"/projects/{p['id']}", "label": f"Open {p['name']}"})
        ui_actions.append({"type": "refresh"})
        return {"created": {"id": p["id"], "name": p["name"], "slug": p["slug"]}}
    if name == "generate_capability":
        proj = _resolve_project(args.get("project_id") or ctx.get("project_id"))
        if not proj:
            return {"error": "Create a project first."}
        r = actions.generate_capability(args["prompt"], proj["id"], args.get("connector_id"))
        cap = r["capability"]
        ui_actions.append({"type": "navigate", "path": f"/capabilities/{cap['id']}", "label": f"Open {cap['name']}"})
        ui_actions.append({"type": "refresh"})
        return {"capability_id": cap["id"], "name": cap["name"], "valid": r["validation"]["valid"],
                "validation": r["validation"]["summary"], "operations": [o["name"] for o in r["spec"]["operations"]],
                "assumptions": r["spec"]["assumptions"], "questions": r["spec"]["questions"],
                "findings": [f["message"] for f in r.get("findings", [])][:6]}
    if name == "run_tests":
        run = actions.run_tests(args["capability_id"])
        ui_actions.append({"type": "navigate", "path": f"/testing?run={run['id']}", "label": "View test run"})
        return {"status": run["status"], "passed": run["passed"], "total": run["total"],
                "failures": [r for r in run["results"] if not r["passed"]][:5]}
    if name == "deploy_to_development":
        d = actions.deploy(args["capability_id"], "development")
        ui_actions.append({"type": "navigate", "path": "/deployments", "label": "View deployments"})
        ui_actions.append({"type": "refresh"})
        return d
    if name == "simulate_policy":
        return actions.simulate(args)
    if name == "navigate":
        ui_actions.append({"type": "navigate", "path": args["path"], "label": args.get("label") or f"Open {args['path']}"})
        return {"ok": True}
    return {"error": f"unknown tool {name}"}


SYSTEM = """You are the built-in assistant of APIfication, an enterprise platform that turns business
requirements into governed REST, GraphQL and MCP capabilities. You help users understand and operate
the application. Be concise, specific and practical. Use the tools to look things up or act; never
invent resource IDs. Prefer search_docs for "how do I" questions. When you change something, say what
changed. You act as {user}; you cannot approve releases or deploy to staging/production — tell the user
where to do that in the UI. Never reveal or ask for secrets in chat; direct users to the forms that
store them in the vault.

Current page: {page}
Context: {context}"""


def chat(messages: list[dict], context: dict) -> dict:
    ui_actions: list[dict] = []
    prov = llm.default_provider()
    provider_name = None
    if llm.is_external(prov):
        try:
            return _chat_llm(prov, messages, context, ui_actions)
        except llm.LLMError as e:
            provider_name = f"{prov['name']} unavailable ({str(e)[:80]}); answered offline"
    r = _chat_offline(messages, context, ui_actions)
    if provider_name:
        r["notice"] = provider_name
    return r


def _chat_llm(prov: dict, messages: list[dict], context: dict, ui_actions: list[dict]) -> dict:
    agent = next((a for a in db.list_records("agent", ORG_ID) if a.get("key") == "assistant"), None)
    if agent and agent.get("provider_id"):
        prov = llm.get_provider(agent["provider_id"]) or prov
    sys = SYSTEM.format(user=CURRENT_USER["name"], page=context.get("page", "/"),
                        context=json.dumps({k: v for k, v in context.items() if k != "page"})[:1500])
    last = messages[-1]["content"] if messages else ""
    hits = kb().search(last, 2)
    if hits:
        sys += "\n\nRelevant documentation:\n" + "\n---\n".join(f"[{h['title']}]\n{h['text'][:900]}" for h in hits)
    convo = [{"role": m["role"], "content": m["content"]} for m in messages[-12:]]
    used: list[str] = []
    for _ in range(6):
        r = llm.complete(prov, convo, system=sys, tools=TOOLS, temperature=0.2, max_tokens=1200)
        if not r["tool_calls"]:
            return {"reply": r["text"].strip() or "Done.", "actions": ui_actions, "tools_used": used,
                    "engine": prov["name"], "sources": [{"title": h["title"], "source": h["source"]} for h in hits]}
        convo.append({"role": "assistant", "content": r["text"], "tool_calls": r["tool_calls"]})
        for tc in r["tool_calls"]:
            used.append(tc["name"])
            try:
                out = call_tool(tc["name"], tc["arguments"], ui_actions, context)
            except Exception as e:  # noqa: BLE001
                out = {"error": str(e)[:300]}
            convo.append({"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(out, default=str)[:6000]})
    return {"reply": "I stopped after several steps. Here is what I did so far.", "actions": ui_actions, "tools_used": used,
            "engine": prov["name"]}


# --------------------------------------------------------------------------- offline engine

PAGE_TIPS = {
    "/": "This is the overview: traffic, denials, deployments and pending approvals across the organisation.",
    "/build": "Describe the API in one sentence: entity, operations, roles, sensitive data and interfaces. Then select Generate.",
    "/connectors": "Register a database with New connector. Credentials go to the vault; connectors start read-only.",
    "/security": "Manage roles, scopes, tags, API clients and policies here. The simulator checks a decision without calling the API.",
    "/mcp": "Create an MCP server, pick deployed operations as tools, and test them as a chosen API client.",
    "/agents": "Configure each agent's model and prompt. Security, testing and review agents are mandatory.",
    "/deployments": "Development needs a validated revision, staging needs passing tests, production needs an approved request.",
    "/testing": "Each run shows every generated test with its category and result.",
    "/graphql": "Pick a project and environment to see the generated schema and try queries.",
    "/monitoring": "Traces show every step of a request: authentication, policy, workflow nodes and redaction.",
    "/settings/providers": "Add a model provider and mark it default to power the assistant and agents.",
}


def _fmt_docs(hits: list[dict]) -> str:
    h = hits[0]
    paras = [p.strip() for p in re.split(r"\n\s*\n", h["text"]) if p.strip()]
    body = "\n\n".join(paras[:3])
    if len(body) > 1400:
        body = body[:1400].rsplit(" ", 1)[0] + "…"
    return f"**{h['title']}**\n\n{body}"


def _chat_offline(messages: list[dict], context: dict, ui_actions: list[dict]) -> dict:
    text = (messages[-1]["content"] if messages else "").strip()
    low = text.lower()
    page = context.get("page", "/")
    used: list[str] = []

    def reply(r: str, sources: list | None = None):
        return {"reply": r, "actions": ui_actions, "tools_used": used, "engine": "Built-in assistant",
                "sources": sources or []}

    if not low or re.fullmatch(r"(hi|hello|hey|help|what can you do\??)[!. ]*", low):
        tip = PAGE_TIPS.get(page, "")
        return reply("I can answer questions about APIfication and act for you. Try:\n"
                     "- *Create a project called Payments*\n"
                     "- *Create a customer API using the Demo CRM database with REST, GraphQL and read-only MCP tools*\n"
                     "- *Run tests* or *Deploy to development* (on a capability page)\n"
                     "- *Why is my capability invalid?*\n- *How do I connect an MCP client?*\n- *Show platform status*"
                     + (f"\n\nOn this page: {tip}" if tip else "")
                     + "\n\nAdd a model provider in Settings to give me full conversational ability.")

    m = re.search(r"\b(?:create|new|add)\s+(?:a\s+)?project\s+(?:called|named)?\s*[\"']?([\w \-]{2,60}?)[\"']?\s*$", low)
    if m and "api" not in low.split("project")[0]:
        name = text[m.start(1):m.end(1)].strip().title() if text[m.start(1):m.end(1)].islower() else text[m.start(1):m.end(1)].strip()
        used.append("create_project")
        r = call_tool("create_project", {"name": name}, ui_actions, context)
        return reply(f"Created project **{r['created']['name']}** (slug `{r['created']['slug']}`). "
                     "Next, open the API Builder to generate its first capability.")

    if re.search(r"\b(create|generate|build|make|design)\b.*\b(api|capability|endpoint|service|mcp server)\b", low):
        used.append("generate_capability")
        r = call_tool("generate_capability", {"prompt": text, "project_id": context.get("project_id")}, ui_actions, context)
        if "error" in r:
            return reply(r["error"])
        lines = [f"Generated **{r['name']}** with {len(r['operations'])} operation(s): {', '.join(r['operations'])}.",
                 f"Validation: {r['validation']}."]
        if r["assumptions"]:
            lines.append("Assumptions:\n" + "\n".join(f"- {a}" for a in r["assumptions"][:6]))
        if r["questions"]:
            lines.append("Open questions:\n" + "\n".join(f"- {q}" for q in r["questions"]))
        if r["findings"]:
            lines.append("Reviewer findings:\n" + "\n".join(f"- {f}" for f in r["findings"]))
        lines.append("Review it on the capability page, then run tests and deploy to development.")
        return reply("\n\n".join(lines))

    cap_id = context.get("capability_id")
    if re.search(r"\brun\b.*\btests?\b|\btest (it|this)\b", low):
        if not cap_id:
            return reply("Open a capability first, or tell me which one. Capabilities are listed under Projects.")
        used.append("run_tests")
        r = call_tool("run_tests", {"capability_id": cap_id}, ui_actions, context)
        msg = f"Test run **{r['status']}**: {r['passed']}/{r['total']} passed."
        if r["failures"]:
            msg += "\n\nFailures:\n" + "\n".join(f"- {f['name']}: {'; '.join(f['problems'])}" for f in r["failures"])
        return reply(msg)

    if re.search(r"\bdeploy\b", low):
        if re.search(r"staging|production|prod\b", low):
            ui_actions.append({"type": "navigate", "path": "/deployments", "label": "Open deployments"})
            return reply("Promotion to staging or production is a governed human action. Open Deployments: staging needs a "
                         "passing test run, production needs an approved release request in Approvals.")
        if not cap_id:
            return reply("Open the capability you want to deploy, then ask again.")
        used.append("deploy_to_development")
        r = call_tool("deploy_to_development", {"capability_id": cap_id}, ui_actions, context)
        if r.get("error"):
            return reply(f"Deployment blocked: {r['error']}")
        return reply(f"Deployed revision {r.get('revision_number')} to **development**. Base URL: `{r.get('base_url', '')}`.")

    if re.search(r"\b(why|what).*\b(invalid|fail|failing|error|errors|wrong|broken)\b", low) and cap_id:
        used.append("get_capability")
        c = t_get_capability(cap_id)
        v = c.get("validation") or {}
        if v.get("valid"):
            return reply(f"**{c['name']}** revision {c['revision']} is valid ({v.get('summary')}). "
                         "If tests fail, open Testing to see each failing case.")
        errs = v.get("errors", [])[:6]
        doc = kb().search("validation errors fixes", 1)
        return reply(f"**{c['name']}** revision {c['revision']} has {v.get('summary')}:\n"
                     + "\n".join(f"- `{e['code']}` {e['message']}" for e in errs)
                     + ("\n\n" + _fmt_docs(doc) if doc else ""), [{"title": d["title"], "source": d["source"]} for d in doc])

    if re.search(r"\b(status|health|overview|how is|summary)\b", low) and not re.search(r"\bhow (do|can|to)\b", low):
        used.append("get_platform_status")
        s = t_status()
        c = s["counts"]
        deps = ", ".join(f"{d['capability']} r{d['revision']} → {d['environment']}" for d in s["active_deployments"]) or "none"
        return reply(f"{c.get('project', 0)} project(s), {c.get('capability', 0)} capabilit(ies) with {s['operations']} operation(s), "
                     f"{c.get('connector', 0)} connector(s), {c.get('mcp_server', 0)} MCP server(s).\n\n"
                     f"Traffic: {s['requests']} request(s), {s['denials']} denied, {s['errors']} error(s); "
                     f"p95 {s['latency_ms']['p95']} ms.\n\nActive deployments: {deps}.\n\n"
                     f"Pending approvals: {s['pending_approvals']}.")

    m = re.search(r"\b(list|show|which|what)\b.*\b(projects|capabilities|apis|connectors|mcp servers|clients|deployments|approvals|providers|agents)\b", low)
    if m and not re.search(r"\bhow\b", low):
        kind = {"apis": "capabilities", "mcp servers": "mcp_servers", "clients": "api_clients"}.get(m.group(2), m.group(2))
        used.append("list_resources")
        items = t_list(kind)["items"]
        if not items:
            return reply(f"There are no {m.group(2)} yet.")
        return reply(f"{len(items)} {m.group(2)}:\n" + "\n".join(
            f"- **{i.get('name')}**" + (f" — {i.get('type') or i.get('status') or i.get('environment') or ''}" if (i.get('type') or i.get('status') or i.get('environment')) else "")
            for i in items[:15]))

    m = re.search(r"\b(?:go to|open|take me to|navigate to|show me)\s+(?:the\s+)?([a-z ]+?)(?:\s+page)?[.?!]*$", low)
    if m:
        target = m.group(1).strip()
        for k, path in ROUTES.items():
            if k in target:
                ui_actions.append({"type": "navigate", "path": path, "label": f"Open {k.title()}"})
                return reply(f"Opening **{k.title()}**.")

    hits = kb().search(text, 3)
    used.append("search_docs")
    if not hits:
        return reply("I couldn't find that in the product guide. Try rephrasing, or add a model provider in Settings for open-ended questions.")
    more = [h for h in hits[1:] if h["title"] != hits[0]["title"]]
    out = _fmt_docs(hits)
    if more:
        out += "\n\nRelated: " + ", ".join(f"*{h['title']}*" for h in more)
    return reply(out, [{"title": h["title"], "source": h["source"]} for h in hits])
