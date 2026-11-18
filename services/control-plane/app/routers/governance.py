"""Security, API clients, tags, MCP servers, deployments, approvals, audit and monitoring."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from .. import db
from ..config import ORG_ID
from ..ir.projections import mcp_tools
from ..models import ApiClientIn, McpServerIn, TagIn
from ..runtime.executor import execute
from ..runtime.gateway import build_graphql, mcp_tool_index
from ..runtime.policy import Principal
from ..services import (CURRENT_USER, ENVIRONMENTS, connectors_map, deployed_specs, issue_token, latest_revision,
                        mint_console_token, overview, public_client, slugify)
from ..vault import vault

router = APIRouter(prefix="/v1", tags=["governance"])
USER = CURRENT_USER["name"]


@router.get("/overview")
def get_overview():
    return overview()


@router.get("/environments")
def environments():
    return [{"name": e, "gate": {"development": "Validated revision", "staging": "Passing test run",
                                 "production": "Approved release request"}[e]} for e in ENVIRONMENTS]


# --------------------------------------------------------------------------- API clients

@router.get("/api-clients")
def list_clients():
    return [public_client(c) for c in db.list_records("api_client", ORG_ID)]


@router.post("/api-clients")
def create_client(body: ApiClientIn):
    if "production" in body.environments and any("*" in s for s in body.scopes):
        raise HTTPException(422, "Wildcard scopes are not allowed for production clients")
    c = {**body.model_dump(), "status": "active"}
    c, token = issue_token(c)
    rec = db.put_record("api_client", ORG_ID, c, id=db.new_id("cli"))
    db.audit(ORG_ID, USER, "api_client.create", resource=rec["id"], details={"scopes": body.scopes, "kind": body.kind})
    return {"client": public_client(rec), "token": token}


@router.patch("/api-clients/{cid}")
def patch_client(cid: str, body: dict = Body(...)):
    c = db.get_record("api_client", cid)
    if not c:
        raise HTTPException(404, "Client not found")
    for k in ("name", "roles", "scopes", "tenant", "environments", "project_ids", "status", "subject"):
        if k in body:
            c[k] = body[k]
    db.audit(ORG_ID, USER, "api_client.update", resource=cid, details={k: body[k] for k in body if k in ("roles", "scopes", "status")})
    return public_client(db.put_record("api_client", ORG_ID, c))


@router.post("/api-clients/{cid}/rotate")
def rotate(cid: str):
    c = db.get_record("api_client", cid)
    if not c:
        raise HTTPException(404, "Client not found")
    c, token = issue_token(c)
    db.put_record("api_client", ORG_ID, c)
    db.audit(ORG_ID, USER, "api_client.rotate", resource=cid)
    return {"client": public_client(c), "token": token}


@router.delete("/api-clients/{cid}")
def delete_client(cid: str):
    db.delete_record("api_client", cid)
    db.audit(ORG_ID, USER, "api_client.delete", resource=cid)
    return {"ok": True}


@router.post("/console/token")
def console_token(body: dict = Body(...)):
    """Short-lived token so a platform user can test as an API client from the UI."""
    c = db.get_record("api_client", body.get("client_id", ""))
    if not c:
        raise HTTPException(404, "Client not found")
    db.audit(ORG_ID, USER, "console.token.mint", resource=c["id"], details={"ttl_s": 600})
    return {"token": mint_console_token(c["id"]), "expires_in": 600}


# --------------------------------------------------------------------------- tags, scopes, roles (org catalogue)

@router.get("/tags")
def list_tags():
    return db.list_records("tag", ORG_ID)


@router.post("/tags")
def create_tag(body: TagIn):
    t = db.put_record("tag", ORG_ID, {**body.model_dump(), "name": f"{body.key}:{body.value}"}, id=db.new_id("tag"))
    db.audit(ORG_ID, USER, "tag.create", resource=t["name"], details={"security_sensitive": body.security_sensitive})
    return t


@router.delete("/tags/{tid}")
def delete_tag(tid: str):
    db.delete_record("tag", tid)
    return {"ok": True}


@router.get("/security/catalogue")
def security_catalogue():
    """Org-wide view of roles, scopes and policies across all capabilities' latest revisions."""
    roles: dict[str, dict] = {}
    scopes: dict[str, dict] = {}
    policies = []
    for cap in db.list_records("capability", ORG_ID):
        rev = latest_revision(cap["id"])
        if not rev:
            continue
        s = rev["spec"]
        for r in s.get("roles", []):
            e = roles.setdefault(r["name"], {"name": r["name"], "description": r.get("description", ""), "scopes": set(), "capabilities": set()})
            e["scopes"] |= set(r["scopes"])
            e["capabilities"].add(cap["name"])
        for sc in s.get("scopes", []):
            e = scopes.setdefault(sc["name"], {"name": sc["name"], "description": sc.get("description", ""), "operations": []})
        for op in s.get("operations", []):
            for sc in op["required_scopes"]:
                scopes.setdefault(sc, {"name": sc, "description": "", "operations": []})["operations"].append(
                    {"capability": cap["name"], "operation": op["name"], "side_effect": op["side_effect"]})
        for p in s.get("policies", []):
            policies.append({**p, "capability_id": cap["id"], "capability": cap["name"], "revision": rev["number"]})
    return {"roles": [{**r, "scopes": sorted(r["scopes"]), "capabilities": sorted(r["capabilities"])} for r in roles.values()],
            "scopes": list(scopes.values()), "policies": policies}


@router.get("/vault/refs")
def vault_refs():
    return vault.list_refs()


# --------------------------------------------------------------------------- deployments

def deploy(capability_id: str, environment: str, revision_id: str | None = None, actor: str = USER,
           approval_id: str | None = None) -> dict:
    cap = db.get_record("capability", capability_id)
    if not cap:
        raise HTTPException(404, "Capability not found")
    if environment not in ENVIRONMENTS:
        raise HTTPException(422, "Unknown environment")
    rev = db.get_revision(revision_id) if revision_id else latest_revision(capability_id)
    if not rev:
        raise HTTPException(404, "Revision not found")
    if not (rev.get("validation") or {}).get("valid"):
        return {"error": "Revision has validation errors. Fix them before deploying.", "status": "blocked"}
    if environment in ("staging", "production"):
        runs = [r for r in db.list_records("test_run", ORG_ID) if r.get("revision_id") == rev["id"] and r["status"] == "passed"]
        if not runs:
            return {"error": f"Run the test suite for revision {rev['number']} and make it pass before promoting to {environment}.",
                    "status": "blocked"}
    if environment == "production" and not approval_id:
        existing = next((a for a in db.list_records("approval", ORG_ID) if a.get("kind") == "release" and a.get("revision_id") == rev["id"]
                         and a.get("environment") == "production" and a.get("status") == "pending"), None)
        if existing:
            return {"status": "pending_approval", "approval_id": existing["id"]}
        appr = db.put_record("approval", ORG_ID, {
            "kind": "release", "status": "pending", "name": f"Release {cap['name']} r{rev['number']} to production",
            "project_id": cap["project_id"], "capability_id": cap["id"], "revision_id": rev["id"], "revision_number": rev["number"],
            "environment": "production", "requested_by": actor, "approver_role": "release_approver",
            "evidence": {"digest": rev["digest"], "validation": rev["validation"]["summary"],
                         "tests": f"{runs[-1]['passed']}/{runs[-1]['total']} passed"}}, project_id=cap["project_id"])
        db.audit(ORG_ID, actor, "release.request", resource=f"{cap['id']}@{rev['number']}", project_id=cap["project_id"])
        return {"status": "pending_approval", "approval_id": appr["id"]}
    for d in db.list_records("deployment", ORG_ID, project_id=cap["project_id"]):
        if d["capability_id"] == capability_id and d["environment"] == environment and d.get("status") == "active":
            d["status"] = "superseded"
            db.put_record("deployment", ORG_ID, d)
    proj = db.get_record("project", cap["project_id"])
    dep = db.put_record("deployment", ORG_ID, {
        "name": f"{cap['name']} → {environment}", "capability_id": capability_id, "capability_name": cap["name"],
        "project_id": cap["project_id"], "revision_id": rev["id"], "revision_number": rev["number"], "digest": rev["digest"],
        "environment": environment, "status": "active", "deployed_by": actor, "approval_id": approval_id,
        "base_url": f"/gw/{environment}/{proj['slug']}/api"}, id=db.new_id("dep"), project_id=cap["project_id"])
    db.set_revision_status(rev["id"], "released")
    db.audit(ORG_ID, actor, "deployment.create", resource=f"{cap['id']}@{rev['number']}", project_id=cap["project_id"],
             details={"environment": environment, "digest": rev["digest"]})
    return dep


@router.get("/deployments")
def list_deployments(project_id: str | None = None):
    return sorted(db.list_records("deployment", ORG_ID, project_id=project_id), key=lambda d: d["created_at"], reverse=True)


@router.post("/deployments")
def post_deployment(body: dict = Body(...)):
    r = deploy(body["capability_id"], body.get("environment", "development"), body.get("revision_id"))
    if r.get("status") == "blocked":
        raise HTTPException(409, r["error"])
    return r


@router.post("/deployments/{did}/undeploy")
def undeploy(did: str):
    d = db.get_record("deployment", did)
    if not d:
        raise HTTPException(404, "Deployment not found")
    d["status"] = "stopped"
    db.put_record("deployment", ORG_ID, d)
    db.audit(ORG_ID, USER, "deployment.stop", resource=did, project_id=d["project_id"], details={"environment": d["environment"]})
    return d


# --------------------------------------------------------------------------- approvals

@router.get("/approvals")
def list_approvals(status: str | None = None):
    a = db.list_records("approval", ORG_ID)
    if status:
        a = [x for x in a if x.get("status") == status]
    return sorted(a, key=lambda x: x["created_at"], reverse=True)


@router.post("/approvals/{aid}/decision")
def decide(aid: str, body: dict = Body(...)):
    a = db.get_record("approval", aid)
    if not a:
        raise HTTPException(404, "Approval not found")
    if a.get("status") != "pending":
        raise HTTPException(409, f"Approval is already {a.get('status')}")
    decision = body.get("decision")
    if decision not in ("approve", "reject"):
        raise HTTPException(422, "decision must be approve or reject")
    if a.get("approver_role") not in CURRENT_USER["roles"] and a.get("approver_role") not in ("admin", "approver"):
        raise HTTPException(403, f"Requires role {a.get('approver_role')}")
    a.update({"status": "approved" if decision == "approve" else "rejected", "decided_by": USER,
              "comment": body.get("comment", ""), "self_approved": a.get("requested_by") == USER})
    result = None
    if decision == "approve":
        if a["kind"] == "release":
            result = deploy(a["capability_id"], "production", a["revision_id"], approval_id=aid)
        elif a["kind"] == "operation":
            rev = db.get_revision(a["revision_id"])
            if rev:
                res = execute(rev["spec"], a["operation_id"], Principal.model_validate(a["principal"]), a["inputs"],
                              environment=a["environment"], interface=a.get("interface", "rest"), connectors=connectors_map(),
                              approved=True, project_id=a["project_id"], capability_id=a["capability_id"], revision_id=rev["id"])
                result = {"status": res.status, "body": res.body}
                a["execution"] = result
    db.put_record("approval", ORG_ID, a)
    db.audit(ORG_ID, USER, f"approval.{decision}", resource=aid, project_id=a.get("project_id"),
             details={"kind": a["kind"], "self_approved": a["self_approved"]})
    return {"approval": a, "result": result}


# --------------------------------------------------------------------------- MCP servers

def _server_view(s: dict) -> dict:
    tools = {}
    for env in ENVIRONMENTS:
        try:
            idx = mcp_tool_index(s, env)
        except Exception:  # noqa: BLE001
            idx = {}
        tools[env] = [{"name": n, "operation": op["name"], "side_effect": op["side_effect"], "scopes": op["required_scopes"]}
                      for n, (_, _, op, _) in idx.items()]
    return {**s, "deployed_tools": tools, "urls": {e: f"/gw/{e}/mcp/{s['slug']}" for e in ENVIRONMENTS}}


@router.get("/mcp-servers")
def list_mcp():
    return [_server_view(s) for s in db.list_records("mcp_server", ORG_ID)]


@router.get("/mcp-servers/candidates")
def mcp_candidates(project_id: str):
    """Operations in the project that have an MCP interface."""
    out = []
    for cap in db.list_records("capability", ORG_ID, project_id=project_id):
        rev = latest_revision(cap["id"])
        if not rev:
            continue
        tools = {t["_meta"]["apf/operation"]: t for t in mcp_tools(rev["spec"])}
        for op in rev["spec"]["operations"]:
            out.append({"key": f"{cap['id']}:{op['id']}", "capability": cap["name"], "operation": op["name"],
                        "tool_name": tools[op["id"]]["name"] if op["id"] in tools else None,
                        "side_effect": op["side_effect"], "scopes": op["required_scopes"],
                        "has_mcp_interface": op["id"] in tools, "description": op.get("description", "")})
    return out


@router.post("/mcp-servers")
def create_mcp(body: McpServerIn):
    slug = slugify(body.name)
    if any(s.get("slug") == slug for s in db.list_records("mcp_server", ORG_ID)):
        raise HTTPException(409, "An MCP server with this name exists")
    s = db.put_record("mcp_server", ORG_ID, {**body.model_dump(), "slug": slug, "version": 1}, id=db.new_id("mcp"),
                      project_id=body.project_id)
    db.audit(ORG_ID, USER, "mcp_server.create", resource=s["id"], project_id=body.project_id,
             details={"tools": body.tool_operation_ids})
    return _server_view(s)


@router.patch("/mcp-servers/{sid}")
def patch_mcp(sid: str, body: dict = Body(...)):
    s = db.get_record("mcp_server", sid)
    if not s:
        raise HTTPException(404, "MCP server not found")
    for k in ("description", "tool_operation_ids", "allowed_client_ids", "discoverable"):
        if k in body:
            s[k] = body[k]
    s["version"] = int(s.get("version", 1)) + 1
    db.audit(ORG_ID, USER, "mcp_server.update", resource=sid, project_id=s["project_id"])
    return _server_view(db.put_record("mcp_server", ORG_ID, s))


@router.delete("/mcp-servers/{sid}")
def delete_mcp(sid: str):
    db.delete_record("mcp_server", sid)
    db.audit(ORG_ID, USER, "mcp_server.delete", resource=sid)
    return {"ok": True}


# --------------------------------------------------------------------------- GraphQL services view

@router.get("/graphql-services")
def graphql_services():
    out = []
    for p in db.list_records("project", ORG_ID):
        for env in ENVIRONMENTS:
            specs = deployed_specs(p["id"], env)
            if not specs:
                continue
            _, sdl, mapping = build_graphql(p["id"], env)
            out.append({"project_id": p["id"], "project": p["name"], "slug": p["slug"], "environment": env,
                        "endpoint": f"/gw/{env}/{p['slug']}/graphql", "sdl": sdl,
                        "fields": [{"root": r, "field": f, "operation": op["name"], "scopes": op["required_scopes"]}
                                   for (r, f), (_, _, op) in mapping.items()],
                        "introspection": env != "production", "max_depth": 6})
    return out


# --------------------------------------------------------------------------- audit + traces

@router.get("/audit-events")
def audit_events(limit: int = 200, project_id: str | None = None, action: str | None = None):
    return db.list_audit(ORG_ID, limit=limit, project_id=project_id, action=action)


@router.get("/traces")
def traces(limit: int = 100, project_id: str | None = None):
    return db.list_traces(ORG_ID, limit=limit, project_id=project_id)


@router.get("/usage")
def usage():
    recs = db.list_records("usage_record", ORG_ID)
    by: dict[str, dict] = {}
    for r in recs:
        k = f"{r.get('name')}::{r.get('model')}"
        e = by.setdefault(k, {"provider": r.get("name"), "model": r.get("model"), "calls": 0, "input_tokens": 0,
                              "output_tokens": 0, "latency_ms": 0})
        u = r.get("usage") or {}
        e["calls"] += 1
        e["input_tokens"] += int(u.get("input_tokens") or u.get("prompt_tokens") or 0)
        e["output_tokens"] += int(u.get("output_tokens") or u.get("completion_tokens") or 0)
        e["latency_ms"] += int(r.get("latency_ms") or 0)
    for e in by.values():
        e["avg_latency_ms"] = int(e["latency_ms"] / e["calls"]) if e["calls"] else 0
    return list(by.values())
