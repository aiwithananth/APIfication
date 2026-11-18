"""Projects, capabilities, revisions, projections, validation, tests and policy simulation."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import PlainTextResponse

from .. import db
from ..ai import agents as agent_pipeline
from ..ai import generator, llm
from ..config import ORG_ID
from ..ir.compiler import compile_capability
from ..ir.nodes import catalogue
from ..ir.projections import graphql_sdl, mcp_tools, openapi, rego
from ..ir.validator import validate
from ..models import GenerateRequest, ProjectIn
from ..runtime.policy import Principal, evaluate
from ..services import CURRENT_USER, connectors_map, latest_revision, save_revision, slugify
from ..testing import generate_tests, run_tests

router = APIRouter(prefix="/v1", tags=["core"])
USER = CURRENT_USER["name"]


@router.get("/me")
def me():
    return CURRENT_USER


@router.get("/node-catalogue")
def node_catalogue():
    return catalogue()


# --------------------------------------------------------------------------- projects

def create_project(name: str, description: str = "", tags: list[str] | None = None, owner: str = "") -> dict:
    slug = slugify(name)
    existing = {p.get("slug") for p in db.list_records("project", ORG_ID)}
    base, i = slug, 2
    while slug in existing:
        slug, i = f"{base}-{i}", i + 1
    p = db.put_record("project", ORG_ID, {"name": name, "description": description, "slug": slug, "tags": tags or [],
                                          "owner": owner or USER, "workspace": "default"}, id=db.new_id("prj"))
    db.audit(ORG_ID, USER, "project.create", resource=p["id"], project_id=p["id"])
    return p


@router.get("/projects")
def list_projects():
    caps = db.list_records("capability", ORG_ID)
    deps = db.list_records("deployment", ORG_ID)
    out = []
    for p in db.list_records("project", ORG_ID):
        out.append({**p, "capability_count": sum(1 for c in caps if c["project_id"] == p["id"]),
                    "active_deployments": sum(1 for d in deps if d["project_id"] == p["id"] and d.get("status") == "active")})
    return out


@router.post("/projects")
def post_project(body: ProjectIn):
    return create_project(body.name, body.description, body.tags, body.owner)


@router.get("/projects/{pid}")
def get_project(pid: str):
    p = db.get_record("project", pid)
    if not p:
        raise HTTPException(404, "Project not found")
    return {**p, "capabilities": db.list_records("capability", ORG_ID, project_id=pid),
            "mcp_servers": db.list_records("mcp_server", ORG_ID, project_id=pid),
            "deployments": db.list_records("deployment", ORG_ID, project_id=pid)}


@router.patch("/projects/{pid}")
def patch_project(pid: str, body: dict = Body(...)):
    p = db.get_record("project", pid)
    if not p:
        raise HTTPException(404, "Project not found")
    p.update({k: v for k, v in body.items() if k in ("name", "description", "tags", "owner")})
    db.audit(ORG_ID, USER, "project.update", resource=pid, project_id=pid)
    return db.put_record("project", ORG_ID, p)


@router.delete("/projects/{pid}")
def delete_project(pid: str):
    if any(d.get("status") == "active" for d in db.list_records("deployment", ORG_ID, project_id=pid)):
        raise HTTPException(409, "Undeploy the project's capabilities before deleting it")
    for c in db.list_records("capability", ORG_ID, project_id=pid):
        db.delete_record("capability", c["id"])
    db.delete_record("project", pid)
    db.audit(ORG_ID, USER, "project.delete", resource=pid)
    return {"ok": True}


# --------------------------------------------------------------------------- capabilities

def _connector_for(project_id: str, connector_id: str | None) -> dict | None:
    conns = list(connectors_map().values())
    if connector_id:
        c = next((c for c in conns if c["id"] == connector_id), None)
        if not c:
            raise HTTPException(404, "Connector not found")
        return c
    scoped = [c for c in conns if not c.get("project_ids") or project_id in c.get("project_ids", [])]
    return next((c for c in scoped if c.get("schema")), None)


def generate_capability(prompt: str, project_id: str, connector_id: str | None = None, save: bool = True,
                        use_agents: bool = True) -> dict:
    if not db.get_record("project", project_id):
        raise HTTPException(404, "Project not found")
    connector = _connector_for(project_id, connector_id)
    cap_id = db.new_id("cap")
    conns = connectors_map()
    if use_agents:
        r = agent_pipeline.run_pipeline(prompt, connector, cap_id, project_id=project_id, actor=USER, connectors=conns)
    else:
        g = generator.generate(prompt, connector, cap_id, llm.default_provider(), conns)
        r = {**g, "validation": validate(g["spec"], conns), "findings": [], "run": None}
    if not save:
        return {**r, "capability": None}
    cap = db.put_record("capability", ORG_ID, {"name": r["spec"]["capability"]["name"], "project_id": project_id,
                                               "description": prompt, "connector_id": (connector or {}).get("id"),
                                               "prompt": prompt, "agent_run_id": (r.get("run") or {}).get("id")},
                        id=cap_id, project_id=project_id)
    rev = save_revision(cap, r["spec"], author=USER, summary="Generated from prompt")
    return {**r, "capability": db.get_record("capability", cap_id), "revision": rev}


@router.post("/capabilities/generate")
def post_generate(body: GenerateRequest, save: bool = True):
    return generate_capability(body.prompt, body.project_id, body.connector_id, save=save, use_agents=body.use_agents)


@router.post("/capabilities")
def post_capability(body: dict = Body(...)):
    """Save a capability from a reviewed (possibly edited) generated spec."""
    spec = body.get("spec")
    project_id = body.get("project_id")
    if not spec or not project_id:
        raise HTTPException(422, "spec and project_id are required")
    cap_id = spec["capability"]["id"]
    cap = db.put_record("capability", ORG_ID, {"name": spec["capability"]["name"], "project_id": project_id,
                                               "description": spec["capability"].get("description", ""),
                                               "prompt": body.get("prompt", ""), "connector_id": body.get("connector_id"),
                                               "agent_run_id": body.get("agent_run_id")}, id=cap_id, project_id=project_id)
    rev = save_revision(cap, spec, author=USER, summary=body.get("summary") or "Created from builder")
    return {"capability": db.get_record("capability", cap_id), "revision": rev}


@router.get("/capabilities")
def list_capabilities(project_id: str | None = None):
    out = []
    projects = {p["id"]: p for p in db.list_records("project", ORG_ID)}
    deps = db.list_records("deployment", ORG_ID)
    for c in db.list_records("capability", ORG_ID, project_id=project_id):
        rev = db.get_revision(c.get("latest_revision_id", "")) if c.get("latest_revision_id") else None
        ops = rev["spec"]["operations"] if rev else []
        kinds = sorted({i["kind"] for o in ops for i in o["interfaces"] if i.get("enabled", True)})
        out.append({**c, "project_name": projects.get(c["project_id"], {}).get("name"),
                    "project_slug": projects.get(c["project_id"], {}).get("slug"),
                    "operation_count": len(ops), "interfaces": kinds, "revision_status": rev["status"] if rev else None,
                    "environments": sorted({d["environment"] for d in deps if d["capability_id"] == c["id"] and d.get("status") == "active"})})
    return out


@router.get("/capabilities/{cid}")
def get_capability(cid: str):
    c = db.get_record("capability", cid)
    if not c:
        raise HTTPException(404, "Capability not found")
    rev = latest_revision(cid)
    return {**c, "revision": rev, "project": db.get_record("project", c["project_id"]),
            "deployments": [d for d in db.list_records("deployment", ORG_ID, project_id=c["project_id"]) if d["capability_id"] == cid],
            "agent_run": db.get_record("agent_run", c["agent_run_id"]) if c.get("agent_run_id") else None}


@router.delete("/capabilities/{cid}")
def delete_capability(cid: str):
    c = db.get_record("capability", cid)
    if not c:
        raise HTTPException(404, "Capability not found")
    if any(d["capability_id"] == cid and d.get("status") == "active" for d in db.list_records("deployment", ORG_ID)):
        raise HTTPException(409, "Undeploy the capability before deleting it")
    db.delete_record("capability", cid)
    db.audit(ORG_ID, USER, "capability.delete", resource=cid, project_id=c["project_id"])
    return {"ok": True}


@router.get("/capabilities/{cid}/revisions")
def list_revs(cid: str):
    return [{k: v for k, v in r.items() if k != "spec"} for r in db.list_revisions(cid)]


@router.get("/capabilities/{cid}/revisions/{rid}")
def get_rev(cid: str, rid: str):
    r = db.get_revision(rid)
    if not r or r["capability_id"] != cid:
        raise HTTPException(404, "Revision not found")
    return r


@router.post("/capabilities/{cid}/revisions")
def post_rev(cid: str, body: dict = Body(...)):
    c = db.get_record("capability", cid)
    if not c:
        raise HTTPException(404, "Capability not found")
    spec = body.get("spec")
    if not spec:
        raise HTTPException(422, "spec is required")
    spec["capability"]["id"] = cid
    if body.get("regenerate_tests"):
        spec["tests"] = generate_tests(spec)
    return save_revision(c, spec, author=USER, summary=body.get("summary") or "Edited")


@router.post("/capabilities/{cid}/validate")
def post_validate(cid: str, body: dict = Body(default={})):
    spec = body.get("spec") or (latest_revision(cid) or {}).get("spec")
    if not spec:
        raise HTTPException(404, "Nothing to validate")
    return validate(spec, connectors_map(), body.get("environment", "development"))


@router.post("/validate")
def validate_spec(body: dict = Body(...)):
    return validate(body["spec"], connectors_map(), body.get("environment", "development"))


def _spec(cid: str, rid: str | None) -> tuple[dict, dict]:
    rev = db.get_revision(rid) if rid else latest_revision(cid)
    if not rev:
        raise HTTPException(404, "Revision not found")
    return rev["spec"], rev


@router.get("/capabilities/{cid}/projections")
def projections(cid: str, revision_id: str | None = None):
    spec, rev = _spec(cid, revision_id)
    return {"openapi": openapi(spec), "graphql": graphql_sdl([spec]), "mcp_tools": mcp_tools(spec), "rego": rego(spec),
            "revision": rev["number"]}


@router.get("/capabilities/{cid}/openapi.json")
def openapi_doc(cid: str, revision_id: str | None = None, server: str = ""):
    spec, _ = _spec(cid, revision_id)
    return openapi(spec, server)


@router.get("/capabilities/{cid}/schema.graphql", response_class=PlainTextResponse)
def sdl_doc(cid: str, revision_id: str | None = None):
    spec, _ = _spec(cid, revision_id)
    return graphql_sdl([spec])


@router.get("/capabilities/{cid}/build")
def build(cid: str, revision_id: str | None = None):
    spec, rev = _spec(cid, revision_id)
    return {**compile_capability(spec, rev["number"]), "revision": rev["number"]}


@router.post("/capabilities/{cid}/tests/generate")
def regen_tests(cid: str):
    c = db.get_record("capability", cid)
    spec, _ = _spec(cid, None)
    spec = {**spec, "tests": generate_tests(spec)}
    rev = save_revision(c, spec, author=USER, summary="Regenerated tests")
    return {"revision": rev, "tests": spec["tests"]}


@router.post("/capabilities/{cid}/tests/run")
def run_cap_tests(cid: str, revision_id: str | None = None):
    c = db.get_record("capability", cid)
    if not c:
        raise HTTPException(404, "Capability not found")
    _, rev = _spec(cid, revision_id)
    return run_tests(c, rev, actor=USER)


@router.get("/test-runs")
def list_runs(capability_id: str | None = None):
    runs = db.list_records("test_run", ORG_ID)
    if capability_id:
        runs = [r for r in runs if r["capability_id"] == capability_id]
    return sorted(runs, key=lambda r: r["created_at"], reverse=True)


@router.get("/test-runs/{rid}")
def get_run(rid: str):
    r = db.get_record("test_run", rid)
    if not r:
        raise HTTPException(404, "Test run not found")
    return r


@router.post("/policies/simulate")
def simulate(body: dict[str, Any] = Body(...)):
    cid = body.get("capability_id", "")
    spec, _ = _spec(cid, body.get("revision_id"))
    op = next((o for o in spec["operations"] if o["id"] == body.get("operation_id")), None)
    if not op:
        raise HTTPException(404, "Operation not found")
    pol = next((p for p in spec["policies"] if p["id"] == op.get("policy_ref")), None)
    from ..models import PolicySpec
    principal = Principal(subject=body.get("subject") or "simulated", kind="synthetic", roles=body.get("roles") or [],
                          scopes=body.get("scopes") or [], tenant=body.get("tenant"))
    d = evaluate(PolicySpec.model_validate(pol) if pol else None, principal, required_scopes=op["required_scopes"],
                 environment=body.get("environment", "development"))
    ent = next((e for e in spec["entities"] if e["name"] == op.get("entity")), None)
    visible = []
    if ent and d.allow:
        for f in ent["fields"]:
            if not f["exposed"]:
                visible.append({"field": f["name"], "result": "removed"})
            elif f.get("masked_unless_scope") and f["masked_unless_scope"] not in principal.scopes:
                visible.append({"field": f["name"], "result": "masked"})
            else:
                visible.append({"field": f["name"], "result": "visible"})
    return {**d.model_dump(), "operation": op["name"], "fields": visible,
            "tenant_filter": bool(ent and ent.get("tenant_key")), "approval_required": op.get("approval_required", False)}
