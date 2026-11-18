"""Natural-language → Canonical Capability Specification (section 4).

Two-stage design:
  1. *Plan extraction* — an approved LLM (if configured) or the deterministic
     parser turns the prompt into a small, typed plan.
  2. *Deterministic builder* — turns the plan plus registered connector metadata
     into a complete CCS (entities, operations, workflows, scopes, policies,
     interfaces, tests). The AI never invents connectors, credentials or schemas.
"""
from __future__ import annotations

import re
from typing import Any

from ..connectors import suggest_classification
from ..models import CapabilitySpec
from ..testing import generate_tests
from . import llm

OP_KINDS = ["search", "get", "update", "create", "set_status"]
TENANT_KEYS = ["tenant_id", "org_id", "organisation_id", "organization_id", "tenant"]
OWNER_KEYS = ["assigned_agent", "assigned_to", "owner_id", "owner", "account_manager", "agent_id"]
STATUS_KEYS = ["status", "account_status", "state"]
NEVER_WRITABLE = {"created_at", "updated_at", "deleted_at", "created_by", "updated_by"}

ROLE_PATTERNS = [
    (r"support[\s-]+agents?", "support_agent"),
    (r"(?:account\s+)?managers?", "manager"),
    (r"admin(?:istrator)?s?", "admin"),
    (r"analysts?", "analyst"),
    (r"auditors?", "auditor"),
    (r"operators?", "operator"),
    (r"(?<!support )\bagents?\b", "agent"),
]
STATUS_VERBS = {"suspend": "suspended", "deactivate": "inactive", "disable": "disabled", "close": "closed",
                "block": "blocked", "reactivate": "active", "activate": "active", "archive": "archived"}
SENSITIVE_WORDS = {
    "payment": r"(card|pan|cc_?num|cvv|iban|payment)", "card": r"(card|pan|cc_?num|cvv)",
    "ssn": r"(ssn|social)", "social security": r"(ssn|social)", "national id": r"(national|gov|tax_?id)",
    "password": r"(password|hash|secret)", "token": r"(token|api_?key)", "birth": r"(dob|birth)",
    "risk": r"(risk|fraud)", "bank": r"(iban|account_?number|bank)",
}


# --------------------------------------------------------------------------- helpers

def singular(w: str) -> str:
    if w.endswith("ies"):
        return w[:-3] + "y"
    if w.endswith("ses") or w.endswith("xes"):
        return w[:-2]
    if w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def pascal(s: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^A-Za-z0-9]", s) if p)


def camel(s: str) -> str:
    p = pascal(s)
    return p[:1].lower() + p[1:]


def tables_of(connector: dict | None) -> list[dict]:
    if not connector:
        return []
    out = []
    for sch in (connector.get("schema") or {}).get("schemas", []):
        out.extend(sch.get("tables", []))
    return out


# --------------------------------------------------------------------------- plan extraction

def heuristic_plan(prompt: str, connector: dict | None) -> dict[str, Any]:
    text = prompt.strip()
    low = text.lower()
    tables = tables_of(connector)
    assumptions: list[str] = []
    questions: list[str] = []

    # --- entity / table
    table = None
    for t in tables:
        n = t["name"].split(".")[-1].lower()
        if re.search(rf"\b({re.escape(n)}|{re.escape(singular(n))})\b", low):
            table = t
            break
    if not table and tables:
        table = tables[0]
        assumptions.append(f"No table was named; using '{table['name']}' from the registered connector.")
    if not tables:
        questions.append("Which registered connector and table should this capability use?")
    tname = table["name"] if table else "records"
    ent_word = singular(tname.split(".")[-1])

    # --- interfaces
    interfaces = []
    if "graphql" in low:
        interfaces.append("graphql")
    if not re.search(r"only\s+graphql|graphql\s+only", low):
        interfaces.insert(0, "rest")
    mcp = bool(re.search(r"\bmcp\b|ai agents?|assistant tools?|agent tools?", low))
    if mcp:
        interfaces.append("mcp")
    mcp_write = bool(re.search(r"mcp[^.]*\b(write|update|modify)\b", low)) and "read-only" not in low and "read only" not in low
    if mcp and not mcp_write:
        assumptions.append("MCP tools are read-only (platform default).")

    # --- operations and roles per clause
    clauses = [c.strip() for c in re.split(r"[.;,]|\band\b(?=\s+\w+(?:\s+\w+)?\s+(?:can|may|should)\b)", low) if c.strip()]
    ops: dict[str, dict] = {}
    read_roles: set[str] = set()
    owner_roles: set[str] = set()

    def add_op(kind: str, roles: set[str], **kw):
        o = ops.setdefault(kind if kind != "set_status" else f"set_status:{kw.get('value')}",
                           {"kind": kind, "roles": set(), **kw})
        o["roles"] |= roles
        if kw.get("approval"):
            o["approval"] = True

    for c in clauses:
        roles = {name for rx, name in ROLE_PATTERNS if re.search(rx, c)}
        if "support_agent" in roles:
            roles.discard("agent")
        approval = "approval" in c or "approve" in c
        reads = bool(re.search(r"\b(read|view|see|access|look ?up)\b", c))
        if re.search(r"\b(search|find|list|browse|lookup)\b", c):
            add_op("search", roles)
        if re.search(r"\b(detail|retriev\w*|get|fetch)\b", c):
            add_op("get", roles)
        if reads and roles:
            add_op("search", roles)
            add_op("get", roles)
            read_roles |= roles
        if re.search(r"\b(update|edit|modify|change|amend)\w*", c):
            fields = []
            if table:
                for col in table["columns"]:
                    if re.search(rf"\b{re.escape(col['name'].replace('_', ' '))}\b|\b{re.escape(col['name'])}\b", c):
                        fields.append(col["name"])
            add_op("update", roles, fields=fields)
        if re.search(rf"\b(create|add|register|onboard)\w* (?:a |an |new )*(?:{re.escape(ent_word)}|record)s?\b(?! (?:service|api|server|platform|portal))", c):
            add_op("create", roles)
        for verb, value in STATUS_VERBS.items():
            if re.search(rf"\b{verb}\w*", c):
                add_op("set_status", roles, value=value, verb=verb, approval=approval)
                break
        if re.search(r"\b(delete|remove|purge)\b", c):
            questions.append("Hard deletes are not generated automatically. Should deletion be modelled as a status change?")
        if "assigned" in c or "their own" in c or "own " in c:
            owner_roles |= roles

    if not ops:
        ops["search"] = {"kind": "search", "roles": set()}
        ops["get"] = {"kind": "get", "roles": set()}
        assumptions.append("No operations were named; generating read operations (search and detail).")

    all_roles = set().union(*(o["roles"] for o in ops.values()))
    if not all_roles:
        all_roles = {"api_consumer"}
        assumptions.append("No roles were named; a single 'api_consumer' role was created.")
        for o in ops.values():
            o["roles"] = {"api_consumer"} if o["kind"] in ("search", "get") else set()
    writers = {r for o in ops.values() if o["kind"] not in ("search", "get") for r in o["roles"]}
    for k in ("search", "get"):
        if k in ops:
            inherit = writers - ops[k]["roles"]
            if inherit:
                ops[k]["roles"] |= writers
                assumptions.append(f"Roles {', '.join(sorted(inherit))} can also read, because they can change records.")
    for o in ops.values():
        if not o["roles"]:
            o["roles"] = set(read_roles or all_roles)
        if o["kind"] in ("update", "create") and not o.get("fields"):
            assumptions.append(f"{o['kind'].title()} uses all non-sensitive, non-key fields. Restrict them in the Database step if needed.")

    # --- sensitive data
    deny_patterns = []
    for m in re.finditer(r"(?:do not|don't|never|must not)\s+(?:expose|return|show|include)\s+([^.;,]+)", low):
        phrase = m.group(1)
        for word, rx in SENSITIVE_WORDS.items():
            if word in phrase:
                deny_patterns.append(rx)
        if not any(w in phrase for w in SENSITIVE_WORDS) and table:
            for col in table["columns"]:
                if col["name"].replace("_", " ") in phrase or col["name"] in phrase:
                    deny_patterns.append(rf"^{re.escape(col['name'])}$")
    deny_fields = []
    if table:
        for col in table["columns"]:
            if any(re.search(rx, col["name"], re.I) for rx in deny_patterns):
                deny_fields.append(col["name"])
    if any(o["kind"] not in ("search", "get") for o in ops.values()) and not re.search(r"\brules?\b|only|permitted|allowed", low):
        questions.append("Which business rules apply to the write operations (e.g. allowed values, who can be updated)?")

    target = "development"
    for env in ("production", "staging"):
        if re.search(rf"deploy\w* to {env}", low):
            target = env
    name = pascal(ent_word) + " API"
    m = re.search(r"\b(?:create|build|generate|make|design) (?:a |an |the )?([a-z0-9 \-]{2,60}?) (?:rest |graphql )?api\b", low) \
        or re.search(r"\b(?:create|build|generate|make|design) (?:a |an |the )?([a-z0-9 \-]{2,60}?) (?:service|capability)\b", low)
    if m:
        name = " ".join(w.capitalize() for w in m.group(1).split() if w not in ("new",)) + " API"
    return {
        "name": name, "description": text[:400], "table": tname, "entity": pascal(ent_word),
        "interfaces": interfaces, "mcp_read_only": not mcp_write,
        "operations": [{**o, "roles": sorted(o["roles"])} for o in ops.values()],
        "owner_filter_roles": sorted(owner_roles), "deny_fields": deny_fields,
        "assumptions": assumptions, "questions": questions, "deploy_target": target, "planner": "deterministic",
    }


PLAN_SYSTEM = """You are the Requirements Analyst of an enterprise API platform. Convert the user's
requirement into a JSON plan. Only use tables and columns listed. Never invent credentials.
Return ONLY JSON with this shape:
{"name": str, "description": str, "table": str, "interfaces": ["rest"|"graphql"|"mcp"],
 "mcp_read_only": bool,
 "operations": [{"kind": "search"|"get"|"update"|"create"|"set_status", "roles": [snake_case role],
                 "fields": [column names for update/create], "value": "status value for set_status",
                 "verb": "suspend etc.", "approval": bool}],
 "owner_filter_roles": [roles restricted to records assigned to them],
 "deny_fields": [columns that must never be exposed],
 "assumptions": [str], "questions": [str only when genuinely blocking],
 "deploy_target": "development"|"staging"|"production"}"""


def llm_plan(prompt: str, connector: dict | None, provider: dict) -> dict | None:
    tables = tables_of(connector)
    tdesc = "\n".join(f"- {t['name']}: " + ", ".join(f"{c['name']} ({c['type']})" for c in t["columns"]) for t in tables[:30])
    plan = llm.complete_json(provider, f"Requirement:\n{prompt}\n\nAvailable tables:\n{tdesc or '(none registered)'}", PLAN_SYSTEM)
    if not plan:
        return None
    names = {t["name"] for t in tables}
    if tables and plan.get("table") not in names:
        return None
    ops = [o for o in plan.get("operations", []) if o.get("kind") in OP_KINDS]
    if not ops:
        return None
    plan["operations"] = ops
    plan.setdefault("interfaces", ["rest"])
    plan["entity"] = pascal(singular(str(plan["table"]).split(".")[-1]))
    plan["planner"] = provider.get("name", "llm")
    return plan


def extract_plan(prompt: str, connector: dict | None, provider: dict | None = None) -> dict:
    if provider and llm.is_external(provider):
        p = llm_plan(prompt, connector, provider)
        if p:
            base = heuristic_plan(prompt, connector)
            p.setdefault("assumptions", [])
            p.setdefault("questions", [])
            # deterministic safety net: sensitive fields found by rules are always denied
            p["deny_fields"] = sorted(set(p.get("deny_fields", [])) | set(base["deny_fields"]))
            return p
    return heuristic_plan(prompt, connector)


# --------------------------------------------------------------------------- deterministic builder

def build_spec(plan: dict, connector: dict | None, capability_id: str) -> dict:
    tables = {t["name"]: t for t in tables_of(connector)}
    table = tables.get(plan["table"]) or {"name": plan["table"], "columns": [{"name": "id", "type": "string", "primary_key": True}]}
    cols = table["columns"]
    names = [c["name"] for c in cols]
    ent_name = plan.get("entity") or pascal(singular(table["name"].split(".")[-1]))
    e = singular(table["name"].split(".")[-1]).lower()
    plural = table["name"].split(".")[-1].lower()
    pk = next((c["name"] for c in cols if c.get("primary_key")), names[0] if names else "id")
    tenant_key = next((k for k in TENANT_KEYS if k in names), None)
    owner_key = next((k for k in OWNER_KEYS if k in names), None)
    status_key = next((k for k in STATUS_KEYS if k in names), None)
    field_policies = (connector or {}).get("field_policies", {})
    deny = set(plan.get("deny_fields", []))
    pii_scope = f"{e}:pii:read"
    assumptions = list(plan.get("assumptions", []))
    questions = list(plan.get("questions", []))

    fields = []
    uses_pii = False
    for c in cols:
        fp = field_policies.get(f"{table['name']}.{c['name']}") or {}
        sug = suggest_classification(c["name"])
        cls = fp.get("classification") or sug["classification"]
        exposed = fp.get("exposed", sug["exposed"]) and c["name"] not in deny
        if cls == "restricted" and not fp.get("masked_unless_scope"):
            exposed = False if c["name"] not in (pk,) else exposed
        masked = fp.get("masked_unless_scope")
        if not masked and exposed and cls == "confidential":
            masked = pii_scope
        if masked == pii_scope:
            uses_pii = True
        writable = (exposed and c["name"] not in {pk, tenant_key, owner_key, *NEVER_WRITABLE}
                    and cls in ("public", "internal", "confidential"))
        fields.append({"name": c["name"], "type": c.get("type", "string"), "classification": cls, "exposed": bool(exposed),
                       "masked_unless_scope": masked if exposed else None, "writable": bool(writable),
                       "description": fp.get("description", "")})
    if tenant_key:
        assumptions.append(f"Tenant isolation uses '{tenant_key}' from the caller's trusted identity, never from request parameters.")
    hidden = [f["name"] for f in fields if not f["exposed"]]
    if hidden:
        assumptions.append(f"Never exposed: {', '.join(hidden)}.")
    if status_key:
        for f in fields:
            if f["name"] == status_key:
                f["writable"] = True

    if plan.get("owner_filter_roles") and not owner_key:
        questions.append("Roles were limited to assigned records, but no owner column (e.g. assigned_agent) was found.")

    interfaces = plan.get("interfaces") or ["rest"]
    scopes: dict[str, str] = {}
    policies = []
    operations = []
    role_scopes: dict[str, set] = {}
    owner_roles = set(plan.get("owner_filter_roles", []))

    for po in plan["operations"]:
        kind = po["kind"]
        roles = po.get("roles") or []
        approval = bool(po.get("approval"))
        if kind == "search":
            oid, oname, scope = f"search_{plural}", f"Search {plural}", f"{e}:search"
            desc = f"Search {plural} visible to the caller. Returns at most 50 rows."
            params = [{"name": "q", "type": "string", "location": "query", "description": "Free-text search", "max_length": 100},
                      {"name": "limit", "type": "integer", "location": "query", "description": "Max rows (≤50)"}]
            side, returns = "read", "many"
            rest = {"method": "GET", "path": f"/{plural}"}
            gql, tool = camel(f"search_{plural}"), f"search_{plural}"
        elif kind == "get":
            oid, oname, scope = f"get_{e}", f"Get {e} details", f"{e}:read"
            desc = f"Retrieve one {e} by id, if the caller is allowed to see it."
            params = [{"name": f"{e}_id", "type": next((f['type'] for f in fields if f['name'] == pk), "string"),
                       "location": "path", "required": True, "description": f"{ent_name} identifier"}]
            side, returns = "read", "one"
            rest = {"method": "GET", "path": f"/{plural}/{{{e}_id}}"}
            gql, tool = camel(e), f"get_{e}"
        elif kind == "update":
            wf = [f for f in fields if f["writable"] and f["name"] != status_key]
            chosen = [f for f in wf if f["name"] in (po.get("fields") or [])] or wf
            oid, oname, scope = f"update_{e}_profile", f"Update {e} profile", f"{e}:profile:update"
            desc = f"Update permitted profile fields of one {e}: {', '.join(f['name'] for f in chosen)}."
            params = ([{"name": f"{e}_id", "type": "string", "location": "path", "required": True, "description": f"{ent_name} identifier"}]
                      + [{"name": f["name"], "type": f["type"], "location": "body", "max_length": 200} for f in chosen])
            side, returns = "write", "one"
            rest = {"method": "PATCH", "path": f"/{plural}/{{{e}_id}}"}
            gql, tool = camel(f"update_{e}_profile"), f"update_{e}_profile"
        elif kind == "create":
            chosen = [f for f in fields if f["writable"] and f["name"] != status_key]
            oid, oname, scope = f"create_{e}", f"Create {e}", f"{e}:create"
            desc = f"Create a {e}."
            params = [{"name": f["name"], "type": f["type"], "location": "body", "max_length": 200} for f in chosen]
            side, returns = "write", "one"
            rest = {"method": "POST", "path": f"/{plural}"}
            gql, tool = camel(f"create_{e}"), f"create_{e}"
        else:  # set_status
            verb = po.get("verb") or "update_status"
            value = po.get("value") or "inactive"
            if not status_key:
                questions.append(f"'{verb}' needs a status column, but none was found on {table['name']}.")
                continue
            oid, oname, scope = f"{verb}_{e}", f"{verb.capitalize()} {e}", f"{e}:status:update"
            desc = f"Set the {e} status to '{value}'." + (" Requires approval." if approval else "")
            params = [{"name": f"{e}_id", "type": "string", "location": "path", "required": True, "description": f"{ent_name} identifier"},
                      {"name": "reason", "type": "string", "location": "body", "max_length": 500, "description": "Reason for the change"}]
            side, returns = "write", "one"
            rest = {"method": "POST", "path": f"/{plural}/{{{e}_id}}/{verb}"}
            gql, tool = camel(f"{verb}_{e}"), f"{verb}_{e}"
        scopes[scope] = desc.split(".")[0]
        pid = f"policy.{e}.{oid}"
        rfs = []
        if owner_key and side in ("read", "write"):
            for r in roles:
                if r in owner_roles:
                    rfs.append({"when_role": r, "field": owner_key, "equals": "$principal.subject"})
        policies.append({"id": pid, "name": f"{oname} policy", "description": f"Who may {oname.lower()}",
                         "roles": roles, "scopes": [scope], "conditions": [], "row_filters": rfs, "version": 1})
        for r in roles:
            role_scopes.setdefault(r, set()).add(scope)

        itfs = []
        if "rest" in interfaces:
            itfs.append({"kind": "rest", **rest})
        if "graphql" in interfaces:
            itfs.append({"kind": "graphql", "field": gql, "operation": "query" if side == "read" else "mutation"})
        if "mcp" in interfaces and (side == "read" or not plan.get("mcp_read_only", True)):
            itfs.append({"kind": "mcp", "tool_name": tool})

        workflow = build_workflow(kind, ent_name, pid, scope, approval, params, e, pk, status_key, po.get("value"),
                                  [p["name"] for p in params if p["location"] == "body" and p["name"] != "reason"])
        operations.append({
            "id": oid, "name": oname, "description": desc, "entity": ent_name, "side_effect": side, "params": params,
            "returns": returns, "required_scopes": [scope], "policy_ref": pid, "approval_required": approval,
            "interfaces": itfs, "workflow": workflow, "tags": [f"domain:{e}", f"operation:{'read-only' if side == 'read' else 'write'}"]
                                                             + (["approval:required"] if approval else []),
        })

    if uses_pii:
        scopes[pii_scope] = f"Read unmasked confidential {e} fields"
    roles_out = [{"name": r, "description": r.replace("_", " ").title(), "scopes": sorted(s)} for r, s in sorted(role_scopes.items())]
    spec = {
        "ccs_version": "1.0",
        "capability": {"id": capability_id, "name": plan.get("name") or f"{ent_name} API",
                       "description": plan.get("description", ""), "domain": e, "owner": "",
                       "classification": "confidential" if any(f["classification"] in ("confidential", "restricted") for f in fields) else "internal",
                       "tags": [f"domain:{e}", f"deploy-target:{plan.get('deploy_target', 'development')}"]
                               + [f"interface:{i}" for i in interfaces], "base_path": f"/{plural}"},
        "entities": [{"name": ent_name, "connector_ref": (connector or {}).get("id", "unregistered"), "resource": table["name"],
                      "primary_key": pk, "tenant_key": tenant_key, "owner_key": owner_key, "fields": fields}],
        "operations": operations,
        "policies": policies,
        "scopes": [{"name": k, "description": v} for k, v in scopes.items()],
        "roles": roles_out,
        "tests": [],
        "assumptions": list(dict.fromkeys(assumptions)),
        "questions": list(dict.fromkeys(questions)),
    }
    CapabilitySpec.model_validate(spec)
    return spec


def build_workflow(kind, ent_name, policy_id, scope, approval, params, e, pk, status_key, status_value, body_fields) -> dict:
    nodes = [{"id": "request", "type": "trigger.request", "label": "Request"},
             {"id": "validate", "type": "data.validate", "label": "Validate input"},
             {"id": "authorize", "type": "security.authorize", "label": "Authorize",
              "config": {"policy_ref": policy_id, "required_scopes": [scope]}}]
    edges = [{"source": "request", "target": "validate"},
             {"source": "validate", "source_port": "valid", "target": "authorize"}]
    prev, port = "authorize", "allowed"
    if approval:
        nodes.append({"id": "approval", "type": "security.approval", "label": "Approval",
                      "config": {"approver_role": "admin", "reason": f"{kind} requested on {ent_name}"}})
        edges.append({"source": prev, "source_port": port, "target": "approval"})
        prev, port = "approval", "approved"
    if kind == "search":
        data = {"id": "load", "type": "database.select", "label": f"Find {e} records",
                "config": {"entity": ent_name, "mode": "many", "search_param": "q", "limit": 50,
                           "search_fields": []}}
    elif kind == "get":
        data = {"id": "load", "type": "database.select", "label": f"Load {e}",
                "config": {"entity": ent_name, "mode": "one", "key_param": f"{e}_id"}}
    elif kind == "update":
        data = {"id": "write", "type": "database.update", "label": f"Update {e}",
                "config": {"entity": ent_name, "key_param": f"{e}_id", "allowed_fields": body_fields}}
    elif kind == "create":
        data = {"id": "write", "type": "database.insert", "label": f"Insert {e}",
                "config": {"entity": ent_name, "allowed_fields": body_fields}}
    else:
        data = {"id": "write", "type": "database.update", "label": f"Set status = {status_value}",
                "config": {"entity": ent_name, "key_param": f"{e}_id", "allowed_fields": [],
                           "set_values": {status_key: status_value}}}
    nodes.append(data)
    edges.append({"source": prev, "source_port": port, "target": data["id"]})
    nodes.append({"id": "redact", "type": "data.redact", "label": "Redact & mask", "config": {"entity": ent_name, "extra_deny": []}})
    edges.append({"source": data["id"], "source_port": "record", "target": "redact"})
    nodes.append({"id": "respond", "type": "output.response", "label": "Response", "config": {}})
    edges.append({"source": "redact", "target": "respond"})
    nodes.append({"id": "deny", "type": "output.error", "label": "Forbidden", "config": {"status": 403, "message": "forbidden"}})
    edges.append({"source": "authorize", "source_port": "denied", "target": "deny"})
    nodes.append({"id": "invalid", "type": "output.error", "label": "Invalid request", "config": {"status": 422, "message": "validation_failed"}})
    edges.append({"source": "validate", "source_port": "invalid", "target": "invalid"})
    if kind == "get" or kind in ("update", "set_status"):
        nodes.append({"id": "missing", "type": "output.error", "label": "Not found", "config": {"status": 404, "message": "not_found"}})
        edges.append({"source": data["id"], "source_port": "empty", "target": "missing"})
    for i, ed in enumerate(edges):
        ed.setdefault("source_port", "out")
        ed.setdefault("target_port", "in")
        ed["id"] = f"e{i}"
    # left-to-right layout wrapped into rows of four; error branches sit under their anchor
    main = [n["id"] for n in nodes if n["type"] != "output.error"]
    per_row, dx, dy = 4, 250, 230
    layout = {nid: {"x": 40 + (i % per_row) * dx, "y": 40 + (i // per_row) * dy} for i, nid in enumerate(main)}
    errs = [n["id"] for n in nodes if n["type"] == "output.error"]
    anchors = {"deny": "authorize", "invalid": "validate", "missing": data["id"]}
    used: dict[tuple, int] = {}
    for nid in errs:
        a = layout.get(anchors.get(nid, "authorize"), {"x": 300, "y": 40})
        key = (a["x"], a["y"])
        used[key] = used.get(key, 0) + 1
        layout[nid] = {"x": a["x"] + 30, "y": a["y"] + 105 * used[key]}
    return {"runtime_class": "synchronous", "nodes": nodes, "edges": edges, "layout": layout}


def search_fields_for(spec: dict) -> dict:
    """Fill search fields with exposed, non-masked string columns (keeps PII out of LIKE scans)."""
    ent = spec["entities"][0] if spec["entities"] else None
    if not ent:
        return spec
    sf = [f["name"] for f in ent["fields"] if f["exposed"] and f["type"] == "string" and not f.get("masked_unless_scope")
          and f["name"] not in (ent.get("tenant_key"), ent.get("owner_key"))][:4]
    for op in spec["operations"]:
        for n in op["workflow"]["nodes"]:
            if n["type"] == "database.select" and n["config"].get("mode") == "many":
                n["config"]["search_fields"] = sf
    return spec


def generate(prompt: str, connector: dict | None, capability_id: str, provider: dict | None = None,
             connectors: dict | None = None) -> dict:
    plan = extract_plan(prompt, connector, provider)
    spec = search_fields_for(build_spec(plan, connector, capability_id))
    spec["tests"] = generate_tests(spec, connectors)
    return {"plan": plan, "spec": spec}
