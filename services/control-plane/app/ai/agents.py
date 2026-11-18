"""Agentic Workspace: a bounded, supervised multi-agent engineering pipeline (section 9).

Every agent has its own identity, tool allowlist and (optionally) its own
model provider. The supervisor cannot bypass validation: mandatory agents
(security, testing, review) always run, and the deterministic validator has
the final word.
"""
from __future__ import annotations

import time
from typing import Any

from .. import db
from ..config import ORG_ID
from ..ir.projections import graphql_sdl, mcp_tools, openapi
from ..ir.validator import validate
from ..testing import generate_tests
from . import generator, llm

DEFAULT_AGENTS: list[dict[str, Any]] = [
    {"key": "supervisor", "name": "Supervisor", "role": "Supervisor / Orchestrator", "order": 10, "mandatory": True,
     "purpose": "Breaks work into tasks, assigns specialists and tracks state.", "tools": ["plan", "delegate"]},
    {"key": "requirements", "name": "Requirements Analyst", "role": "Requirements Analyst", "order": 20,
     "purpose": "Extracts entities, operations, roles, constraints and ambiguities.", "tools": ["read_prompt", "catalog.search"]},
    {"key": "database", "name": "Database Architect", "role": "Database Architect", "order": 30,
     "purpose": "Maps approved schema metadata to entities; applies classification.", "tools": ["connector.schema"]},
    {"key": "api", "name": "API Architect", "role": "API Architect", "order": 40,
     "purpose": "Designs REST contracts and versioning.", "tools": ["openapi.generate"]},
    {"key": "graphql", "name": "GraphQL Architect", "role": "GraphQL Architect", "order": 50,
     "purpose": "Designs types, queries, mutations and resolver mapping.", "tools": ["graphql.generate"]},
    {"key": "workflow", "name": "Workflow Engineer", "role": "Workflow Engineer", "order": 60,
     "purpose": "Builds the typed workflow graph for each operation.", "tools": ["ir.build"]},
    {"key": "security", "name": "Security Architect", "role": "Security Architect", "order": 70, "mandatory": True,
     "purpose": "Designs roles, scopes, tags and policies; produces a threat model.", "tools": ["policy.build", "classification.read"]},
    {"key": "mcp", "name": "MCP Engineer", "role": "MCP Engineer", "order": 80,
     "purpose": "Creates approved MCP tool definitions.", "tools": ["mcp.generate"]},
    {"key": "tests", "name": "Test Architect", "role": "Test Architect", "order": 90, "mandatory": True,
     "purpose": "Designs functional, negative, role-matrix and isolation tests.", "tools": ["tests.generate"]},
    {"key": "reviewer", "name": "Reviewer / Critic", "role": "Reviewer / Critic", "order": 100, "mandatory": True,
     "purpose": "Independently challenges assumptions and generated output.", "tools": ["ir.validate", "policy.lint"]},
    {"key": "release", "name": "Release Agent", "role": "Release Agent", "order": 110,
     "purpose": "Prepares a deployment plan and evidence. Cannot approve releases.", "tools": ["deploy.plan"]},
    {"key": "operations", "name": "Operations Agent", "role": "Operations Agent", "order": 120, "enabled": False,
     "purpose": "Reviews telemetry, failures and performance after release.", "tools": ["traces.read"]},
]

ROLE_PROMPTS = {
    "requirements": "Extract a precise, typed plan from the requirement. Flag only blocking ambiguities.",
    "reviewer": ("You are an independent security reviewer. Given a capability summary, list concrete risks: "
                 "over-broad access, missing tenant isolation, sensitive fields exposed, write tools exposed to agents, "
                 "missing approvals. Answer as short bullet points. If none, say 'No blocking findings.'"),
}


def agent_records() -> dict[str, dict]:
    return {a.get("key"): a for a in db.list_records("agent", ORG_ID)}


def _provider_for(agent: dict | None) -> dict | None:
    if agent and agent.get("provider_id"):
        p = llm.get_provider(agent["provider_id"])
        if p:
            return p
    return llm.default_provider()


def review(spec: dict, validation: dict) -> list[dict]:
    """Deterministic critic checks layered on top of the validator."""
    findings = []
    for ent in spec["entities"]:
        if not ent.get("tenant_key"):
            findings.append({"severity": "medium", "message": f"{ent['name']} has no tenant key; data is not tenant-isolated."})
        for f in ent["fields"]:
            if f["classification"] in ("confidential", "restricted") and f["exposed"] and not f.get("masked_unless_scope"):
                findings.append({"severity": "high", "message": f"{ent['name']}.{f['name']} is {f['classification']} and returned unmasked."})
    for op in spec["operations"]:
        if op["side_effect"] != "read" and any(i["kind"] == "mcp" for i in op["interfaces"]):
            findings.append({"severity": "high", "message": f"Write operation {op['id']} is exposed as an MCP tool."})
        pol = next((p for p in spec["policies"] if p["id"] == op.get("policy_ref")), None)
        if pol and not pol.get("roles"):
            findings.append({"severity": "medium", "message": f"{op['id']} allows any role holding its scope."})
        if op["side_effect"] != "read" and not op.get("approval_required") and len((pol or {}).get("roles", [])) > 2:
            findings.append({"severity": "low", "message": f"{op['id']} is a write available to {len(pol['roles'])} roles without approval."})
    for e in validation["errors"]:
        findings.append({"severity": "blocking", "message": e["message"]})
    return findings


def run_pipeline(prompt: str, connector: dict | None, capability_id: str, *, project_id: str, actor: str,
                 connectors: dict | None = None) -> dict:
    agents = agent_records()
    steps: list[dict] = []
    t_all = time.perf_counter()

    def step(key: str, fn):
        a = agents.get(key, {})
        enabled = a.get("enabled", True) or a.get("mandatory")
        if not enabled:
            steps.append({"agent": key, "name": a.get("name", key), "status": "skipped", "summary": "Disabled", "ms": 0})
            return None
        t0 = time.perf_counter()
        prov = _provider_for(a)
        try:
            out, summary = fn(prov if llm.is_external(prov) else None)
            steps.append({"agent": key, "name": a.get("name", key), "status": "completed", "summary": summary,
                          "model": (prov or {}).get("model") if llm.is_external(prov) else "deterministic",
                          "ms": int((time.perf_counter() - t0) * 1000)})
            return out
        except Exception as ex:  # noqa: BLE001
            steps.append({"agent": key, "name": a.get("name", key), "status": "failed", "summary": str(ex)[:300],
                          "ms": int((time.perf_counter() - t0) * 1000)})
            raise

    tasks = ["requirements", "database", "api", "graphql", "workflow", "security", "mcp", "tests", "reviewer", "release"]
    step("supervisor", lambda p: (tasks, f"Planned {len(tasks)} tasks; mandatory gates: security, tests, review"))
    plan = step("requirements", lambda p: (_plan := generator.extract_plan(prompt, connector, p),
                                           f"{len(_plan['operations'])} operation(s), roles: {', '.join(sorted({r for o in _plan['operations'] for r in o.get('roles', [])})) or 'none'}; "
                                           f"planner: {_plan.get('planner')}"))
    spec = step("database", lambda p: (_s := generator.search_fields_for(generator.build_spec(plan, connector, capability_id)),
                                       f"Mapped {_s['entities'][0]['resource'] if _s['entities'] else '-'}: "
                                       f"{sum(1 for f in (_s['entities'][0]['fields'] if _s['entities'] else []) if f['exposed'])} exposed, "
                                       f"{sum(1 for f in (_s['entities'][0]['fields'] if _s['entities'] else []) if not f['exposed'])} hidden fields"))
    step("api", lambda p: (None, f"{len(openapi(spec)['paths'])} REST path(s) in OpenAPI 3.1"))
    gql_fields = [i["field"] for o in spec["operations"] for i in o["interfaces"] if i["kind"] == "graphql"]
    step("graphql", lambda p: (graphql_sdl([spec]), f"{len(gql_fields)} field(s): {', '.join(gql_fields)}" if gql_fields else "GraphQL not requested"))
    step("workflow", lambda p: (None, f"{sum(len(o['workflow']['nodes']) for o in spec['operations'])} nodes across {len(spec['operations'])} workflow(s)"))
    step("security", lambda p: (None, f"{len(spec['roles'])} role(s), {len(spec['scopes'])} scope(s), {len(spec['policies'])} polic(ies); "
                                f"{sum(1 for pl in spec['policies'] if pl['row_filters'])} with row-level filters"))
    step("mcp", lambda p: (None, f"{len(mcp_tools(spec))} tool(s), all read-only" if all(
        o['side_effect'] == 'read' for o in spec['operations'] if any(i['kind'] == 'mcp' for i in o['interfaces'])) else f"{len(mcp_tools(spec))} tool(s)"))
    spec["tests"] = step("tests", lambda p: (_t := generate_tests(spec, connectors), f"{len(_t)} test(s) across "
                                             f"{len({t['category'] for t in _t})} categories"))
    validation = validate(spec, connectors or {})

    def do_review(p):
        f = review(spec, validation)
        if p:
            summary = "\n".join(f"{o['name']} ({o['side_effect']}): roles {next((pl['roles'] for pl in spec['policies'] if pl['id'] == o['policy_ref']), [])}, "
                                f"interfaces {[i['kind'] for i in o['interfaces']]}" for o in spec["operations"])
            try:
                txt = llm.complete_text(p, [{"role": "user", "content": summary}], system=ROLE_PROMPTS["reviewer"], max_tokens=400)
                if txt and "no blocking" not in txt.lower():
                    for line in [ln.strip("-• ").strip() for ln in txt.splitlines() if ln.strip()][:6]:
                        f.append({"severity": "advisory", "message": line, "source": "model"})
            except llm.LLMError:
                pass
        return f, f"{len(f)} finding(s); validator: {validation['summary']}"
    findings = step("reviewer", do_review) or []
    step("release", lambda p: (None, f"Target: {plan.get('deploy_target', 'development')}. Production requires human approval and passing tests."))

    run = db.put_record("agent_run", ORG_ID, {
        "name": spec["capability"]["name"], "prompt": prompt, "capability_id": capability_id, "project_id": project_id,
        "steps": steps, "findings": findings, "plan": plan, "validation": {k: validation[k] for k in ("valid", "summary")},
        "duration_ms": int((time.perf_counter() - t_all) * 1000), "actor": actor,
    }, project_id=project_id)
    return {"plan": plan, "spec": spec, "validation": validation, "findings": findings, "run": run}
