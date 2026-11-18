"""Database & Connector Centre."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from .. import db
from ..config import ORG_ID
from ..connectors import PLANNED, SUPPORTED, get_connector, suggest_classification
from ..models import ConnectorIn
from ..runtime.executor import mask_value
from ..services import CURRENT_USER
from ..vault import vault

router = APIRouter(prefix="/v1/connectors", tags=["connectors"])
USER = CURRENT_USER["name"]

TYPE_INFO = {
    "postgresql": {"label": "PostgreSQL", "category": "Relational", "default_port": 5432, "status": "supported"},
    "sqlite": {"label": "SQLite (local development)", "category": "Relational", "status": "supported"},
    "rest_api": {"label": "Existing REST API", "category": "API", "status": "supported"},
    "graphql_api": {"label": "Existing GraphQL API", "category": "API", "status": "supported"},
    "mysql": {"label": "MySQL / MariaDB", "category": "Relational", "default_port": 3306, "status": "planned"},
    "sqlserver": {"label": "Microsoft SQL Server", "category": "Relational", "default_port": 1433, "status": "planned"},
    "oracle": {"label": "Oracle Database", "category": "Relational", "default_port": 1521, "status": "planned"},
    "mongodb": {"label": "MongoDB", "category": "Document", "default_port": 27017, "status": "planned"},
    "snowflake": {"label": "Snowflake", "category": "Analytics", "status": "planned"},
    "bigquery": {"label": "BigQuery", "category": "Analytics", "status": "planned"},
}


def public(c: dict) -> dict:
    out = {k: v for k, v in c.items() if k not in ("secret_ref", "schema")}
    out["has_secret"] = bool(c.get("secret_ref"))
    out["table_count"] = sum(len(s.get("tables", [])) for s in (c.get("schema") or {}).get("schemas", []))
    return out


@router.get("/types")
def types():
    return [{"type": k, **v} for k, v in TYPE_INFO.items()]


@router.get("")
def list_connectors():
    return [public(c) for c in db.list_records("connector", ORG_ID)]


@router.post("")
def create_connector(body: ConnectorIn):
    if body.type in PLANNED:
        raise HTTPException(422, f"{TYPE_INFO[body.type]['label']} is planned but not yet production-supported")
    if body.type == "sqlite" and body.hosting != "local_development":
        raise HTTPException(422, "SQLite connectors are only allowed for local development")
    if body.type == "postgresql" and body.tls_mode == "disable" and body.hosting != "local_development":
        raise HTTPException(422, "TLS cannot be disabled for remote databases")
    data = body.model_dump(exclude={"password"})
    if body.password:
        data["secret_ref"] = vault.put(body.password, label=f"connector:{body.name}", owner=USER)
    data.update({"status": "active", "health": "untested", "read_only": True,  # read-only until explicitly approved
                 "field_policies": {}, "schema": None})
    c = db.put_record("connector", ORG_ID, data, id=db.new_id("conn"))
    db.audit(ORG_ID, USER, "connector.create", resource=c["id"], details={"type": body.type, "hosting": body.hosting})
    return public(c)


@router.get("/{cid}")
def get_connector_rec(cid: str):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    return {**public(c), "schema": c.get("schema")}


@router.patch("/{cid}")
def patch_connector(cid: str, body: dict = Body(...)):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    allowed = {"name", "host", "port", "database", "username", "tls_mode", "base_url", "tags", "owner", "classification",
               "project_ids", "options", "environment", "status"}
    for k, v in body.items():
        if k in allowed:
            c[k] = v
    if "read_only" in body and body["read_only"] != c.get("read_only", True):
        c["read_only"] = bool(body["read_only"])
        db.audit(ORG_ID, USER, "connector.write_access." + ("revoke" if c["read_only"] else "grant"), resource=cid,
                 details={"reason": body.get("reason", "")})
    if body.get("password"):
        if c.get("secret_ref"):
            vault.delete(c["secret_ref"])
        c["secret_ref"] = vault.put(body["password"], label=f"connector:{c['name']}", owner=USER)
        db.audit(ORG_ID, USER, "connector.credential.rotate", resource=cid)
    db.audit(ORG_ID, USER, "connector.update", resource=cid, details={"fields": [k for k in body if k != "password"]})
    return public(db.put_record("connector", ORG_ID, c))


@router.delete("/{cid}")
def delete_connector(cid: str):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    for cap in db.list_records("capability", ORG_ID):
        if cap.get("connector_id") == cid:
            raise HTTPException(409, f"Connector is used by capability {cap['name']}")
    if c.get("secret_ref"):
        vault.delete(c["secret_ref"])
    db.delete_record("connector", cid)
    db.audit(ORG_ID, USER, "connector.delete", resource=cid)
    return {"ok": True}


@router.post("/{cid}/test")
def test_connector(cid: str):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    try:
        r = get_connector(c).test()
    except Exception as e:  # noqa: BLE001
        r = {"ok": False, "error": str(e)[:200], "checks": []}
    c["health"] = "healthy" if r.get("ok") else "failing"
    c["last_test"] = {k: v for k, v in r.items()}
    db.put_record("connector", ORG_ID, c)
    db.audit(ORG_ID, USER, "connector.test", resource=cid, outcome="success" if r.get("ok") else "failure")
    return r


@router.post("/{cid}/discover")
def discover(cid: str):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    try:
        schema = get_connector(c).discover()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Discovery failed: {str(e)[:200]}") from e
    fp = c.get("field_policies") or {}
    for sch in schema["schemas"]:
        for t in sch["tables"]:
            for col in t["columns"]:
                key = f"{t['name']}.{col['name']}"
                s = suggest_classification(col["name"])
                col["suggestion"] = s
                if key not in fp:
                    fp[key] = {"classification": s["classification"], "exposed": s["exposed"], "source": "suggested"}
    c["schema"] = schema
    c["field_policies"] = fp
    db.put_record("connector", ORG_ID, c)
    db.audit(ORG_ID, USER, "connector.discover", resource=cid,
             details={"tables": sum(len(s["tables"]) for s in schema["schemas"])})
    return {"schema": schema, "field_policies": fp}


@router.get("/{cid}/schema")
def schema(cid: str):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    return {"schema": c.get("schema"), "field_policies": c.get("field_policies", {})}


@router.put("/{cid}/field-policies")
def put_field_policies(cid: str, body: dict = Body(...)):
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    fp = c.get("field_policies") or {}
    for k, v in body.items():
        fp[k] = {**fp.get(k, {}), **v, "source": "admin"}
    c["field_policies"] = fp
    db.put_record("connector", ORG_ID, c)
    db.audit(ORG_ID, USER, "connector.classification.update", resource=cid, details={"fields": list(body)})
    return fp


@router.post("/{cid}/preview")
def preview(cid: str, body: dict = Body(...)):
    """Development-only, masked sample rows."""
    c = db.get_record("connector", cid)
    if not c:
        raise HTTPException(404, "Connector not found")
    if c.get("environment") != "development":
        raise HTTPException(403, "Data preview is available for development connectors only")
    table = body.get("table", "")
    known = {t["name"] for s in (c.get("schema") or {}).get("schemas", []) for t in s["tables"]}
    if table not in known:
        raise HTTPException(404, "Unknown table — run discovery first")
    rows = get_connector(c).select(table, [], [], limit=5)
    fp = c.get("field_policies", {})
    out = []
    for r in rows:
        row = {}
        for k, v in r.items():
            p = fp.get(f"{table}.{k}", {})
            if not p.get("exposed", True) or p.get("classification") in ("confidential", "restricted"):
                row[k] = mask_value(v)
            else:
                row[k] = v
        out.append(row)
    db.audit(ORG_ID, USER, "connector.preview", resource=f"{cid}:{table}")
    return {"rows": out, "masked": True}
