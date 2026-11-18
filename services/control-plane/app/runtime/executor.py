"""Synchronous workflow runtime (low-latency path, section 26.6).

REST, GraphQL and MCP all call `execute()`. There is exactly one execution
and policy path per operation, so switching interface can never change what
a caller is allowed to do.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from .. import db
from ..config import EGRESS_ALLOWLIST, ORG_ID
from ..connectors import ConnectorError, get_connector
from ..models import CapabilitySpec, EntitySpec, OperationSpec
from ..vault import vault
from .policy import Decision, Principal, evaluate

MAX_STEPS = 64
CLASS_RANK = {"public": 0, "internal": 1, "confidential": 2, "restricted": 3}


class ExecutionResult:
    def __init__(self, status: int, body: Any, spans: list[dict], decision: Decision | None = None):
        self.status = status
        self.body = body
        self.spans = spans
        self.decision = decision

    def to_dict(self) -> dict:
        return {"status": self.status, "body": self.body, "spans": self.spans,
                "decision": self.decision.model_dump() if self.decision else None}


class _Stop(Exception):
    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body


def args_hash(op_id: str, inputs: dict) -> str:
    return hashlib.sha256(json.dumps([op_id, inputs], sort_keys=True, default=str).encode()).hexdigest()[:24]


def mask_value(v: Any) -> Any:
    if v is None:
        return None
    s = str(v)
    if "@" in s:
        name, _, dom = s.partition("@")
        return (name[:1] + "•••@" + dom) if name else "•••"
    return "•••• " + s[-4:] if len(s) > 4 else "••••"


def coerce(value: Any, typ: str) -> Any:
    if value is None:
        return None
    if typ == "integer":
        return int(value)
    if typ == "number":
        return float(value)
    if typ == "boolean":
        return value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes")
    return str(value) if not isinstance(value, (dict, list)) else value


def execute(spec_dict: dict, operation_id: str, principal: Principal, inputs: dict[str, Any], *,
            environment: str, interface: str, connectors: dict[str, dict] | None = None,
            approved: bool = False, project_id: str | None = None, capability_id: str | None = None,
            revision_id: str | None = None) -> ExecutionResult:
    spec = CapabilitySpec.model_validate(spec_dict)
    op = next((o for o in spec.operations if o.id == operation_id), None)
    spans: list[dict] = []
    if not op:
        return ExecutionResult(404, {"error": "operation_not_found"}, spans)
    connectors = connectors if connectors is not None else {c["id"]: c for c in db.list_records("connector", ORG_ID)}
    ents = {e.name: e for e in spec.entities}
    policies = {p.id: p for p in spec.policies}
    nodes = {n.id: n for n in op.workflow.nodes}
    out_edges: dict[str, list] = {}
    for e in op.workflow.edges:
        out_edges.setdefault(e.source, []).append(e)
    entry = next((n for n in op.workflow.nodes if n.type.startswith("trigger.")), None)
    if not entry:
        return ExecutionResult(500, {"error": "workflow_has_no_entry"}, spans)

    state: dict[str, Any] = {"decision": None, "row_filters": [], "inputs": dict(inputs)}
    authorized = False
    queue: list[tuple[str, Any]] = [(entry.id, dict(inputs))]
    steps = 0
    result: ExecutionResult | None = None
    try:
        while queue:
            steps += 1
            if steps > MAX_STEPS:
                raise _Stop(500, {"error": "step_budget_exceeded"})
            nid, payload = queue.pop(0)
            node = nodes[nid]
            t0 = time.perf_counter()
            span = {"node_id": nid, "type": node.type, "label": node.label or nid, "status": "ok", "detail": ""}
            try:
                if node.type in ("database.select", "database.update", "database.insert", "http.request", "ai.model_call") and not authorized:
                    # defence in depth: the validator forbids this, the runtime refuses it too
                    raise _Stop(403, {"error": "forbidden", "reason": "Data access attempted before authorization"})
                port, payload, done = _run_node(node, op, spec, ents, policies, connectors, principal, payload, state,
                                                environment=environment, approved=approved, interface=interface,
                                                project_id=project_id, capability_id=capability_id, revision_id=revision_id)
                if node.type == "security.authorize" and port == "allowed":
                    authorized = True
                span["port"] = port
                span["detail"] = state.pop("_detail", "")
            except _Stop as s:
                span["status"] = "stopped"
                span["detail"] = str(s.body.get("reason") or s.body.get("error")) if isinstance(s.body, dict) else ""
                span["ms"] = round((time.perf_counter() - t0) * 1000, 2)
                spans.append(span)
                raise
            span["ms"] = round((time.perf_counter() - t0) * 1000, 2)
            spans.append(span)
            if done is not None:
                result = ExecutionResult(done[0], done[1], spans, state["decision"])
                break
            nexts = [e for e in out_edges.get(nid, []) if e.source_port == port]
            if not nexts:
                if port in ("denied",):
                    raise _Stop(403, {"error": "forbidden", "reason": state["decision"].reason if state["decision"] else ""})
                if port == "empty":
                    raise _Stop(404, {"error": "not_found"})
                if port in ("invalid",):
                    raise _Stop(422, {"error": "validation_failed", "details": state.get("validation_errors")})
                raise _Stop(500, {"error": "workflow_dead_end", "node": nid, "port": port})
            for e in nexts:
                queue.append((e.target, payload))
    except _Stop as s:
        result = ExecutionResult(s.status, s.body, spans, state["decision"])
    except ConnectorError as ce:
        result = ExecutionResult(502, {"error": "connector_error", "reason": str(ce)}, spans, state["decision"])
    if result is None:
        result = ExecutionResult(500, {"error": "no_response"}, spans, state["decision"])
    return result


def _entity(node, op, ents) -> EntitySpec:
    name = node.config.get("entity") or op.entity
    ent = ents.get(name or "")
    if not ent:
        raise _Stop(500, {"error": "entity_not_found", "reason": f"Unknown entity {name}"})
    return ent


def _where(ent: EntitySpec, principal: Principal, state: dict) -> list[tuple[str, str, Any]]:
    where: list[tuple[str, str, Any]] = []
    if ent.tenant_key:
        if not principal.tenant:
            raise _Stop(403, {"error": "forbidden", "reason": "Tenant context required for tenant-scoped data"})
        where.append((ent.tenant_key, "=", principal.tenant))
    for rf in state["row_filters"]:
        where.append((rf["field"], "=", rf["equals"]))
    return where


def _run_node(node, op: OperationSpec, spec, ents, policies, connectors, principal: Principal, payload, state, *,
              environment, approved, interface, project_id, capability_id, revision_id):
    cfg = node.config
    t = node.type
    if t.startswith("trigger."):
        return "out", payload, None

    if t == "security.authorize":
        pol = policies.get(cfg.get("policy_ref") or op.policy_ref or "")
        req = list(dict.fromkeys([*op.required_scopes, *cfg.get("required_scopes", [])]))
        dec = evaluate(pol, principal, required_scopes=req, environment=environment,
                       request={"interface": interface, "operation": op.id})
        state["decision"] = dec
        state["row_filters"] = dec.row_filters
        state["_detail"] = dec.reason + (f" (policy {dec.policy_id} v{dec.policy_version})" if dec.policy_id else "")
        db.audit(ORG_ID, principal.client_name or principal.subject, "policy.decision", actor_type=principal.kind,
                 resource=f"{spec.capability.id}:{op.id}", outcome="allow" if dec.allow else "deny", project_id=project_id,
                 details={"policy": dec.policy_id, "version": dec.policy_version, "reason": dec.reason,
                          "interface": interface, "environment": environment})
        return ("allowed" if dec.allow else "denied"), payload, None

    if t == "security.approval":
        if approved:
            state["_detail"] = "Approved request resumed"
            return "approved", payload, None
        h = args_hash(op.id, state["inputs"])
        appr = db.put_record("approval", ORG_ID, {
            "kind": "operation", "status": "pending", "name": f"{op.name}",
            "project_id": project_id, "capability_id": capability_id, "revision_id": revision_id,
            "operation_id": op.id, "environment": environment, "interface": interface,
            "inputs": state["inputs"], "args_hash": h, "principal": principal.model_dump(),
            "approver_role": cfg.get("approver_role", "approver"), "reason": cfg.get("reason", ""),
            "requested_by": principal.client_name or principal.subject,
        }, project_id=project_id)
        state["_detail"] = f"Held for approval {appr['id']}"
        raise _Stop(202, {"status": "pending_approval", "approval_id": appr["id"],
                          "message": f"This operation requires approval by {cfg.get('approver_role', 'an approver')}."})

    if t == "data.validate":
        errors = []
        clean = dict(payload) if isinstance(payload, dict) else {}
        for p in op.params:
            v = clean.get(p.name)
            if v in (None, ""):
                if p.required or p.location == "path":
                    errors.append({"field": p.name, "error": "required"})
                continue
            try:
                clean[p.name] = coerce(v, p.type)
            except (ValueError, TypeError):
                errors.append({"field": p.name, "error": f"must be {p.type}"})
                continue
            if p.max_length and len(str(v)) > p.max_length:
                errors.append({"field": p.name, "error": f"longer than {p.max_length}"})
        for fname, rule in (cfg.get("rules") or {}).items():
            v = clean.get(fname)
            if v is not None and rule.get("pattern") and not re.match(rule["pattern"], str(v)):
                errors.append({"field": fname, "error": "pattern mismatch"})
        allowed = {p.name for p in op.params}
        unknown = [k for k in clean if k not in allowed and not k.startswith("_")]
        if unknown:
            errors.append({"field": ",".join(unknown), "error": "unknown parameter"})
        if errors:
            state["validation_errors"] = errors
            state["_detail"] = f"{len(errors)} validation error(s)"
            return "invalid", payload, None
        state["inputs"] = clean
        return "valid", clean, None

    if t == "database.select":
        ent = _entity(node, op, ents)
        conn = get_connector(_conn(connectors, ent))
        fields = [f.name for f in ent.fields if f.exposed]
        if ent.primary_key not in fields:
            fields.append(ent.primary_key)
        where = _where(ent, principal, state)
        mode = cfg.get("mode", "many")
        inputs = state["inputs"]
        limit = int(cfg.get("limit") or 50)
        if inputs.get("limit"):
            limit = min(limit, int(inputs["limit"]))
        if mode == "one":
            kp = cfg.get("key_param") or ent.primary_key
            key = inputs.get(kp)
            if key is None:
                raise _Stop(422, {"error": "validation_failed", "details": [{"field": kp, "error": "required"}]})
            pk_field = next((f for f in ent.fields if f.name == ent.primary_key), None)
            where.append((ent.primary_key, "=", coerce(key, pk_field.type if pk_field else "string")))
            rows = conn.select(ent.resource, fields, where, limit=1)
            state["_detail"] = f"{ent.resource}: {len(rows)} row(s), {len(where)} filter(s)"
            return ("record", rows[0], None) if rows else ("empty", None, None)
        search = None
        sp = cfg.get("search_param")
        if sp and inputs.get(sp):
            search = (cfg.get("search_fields") or [], str(inputs[sp]))
        rows = conn.select(ent.resource, fields, where, limit=limit, search=search)
        state["_detail"] = f"{ent.resource}: {len(rows)} row(s), {len(where)} filter(s)"
        return "record", rows, None

    if t == "database.update":
        ent = _entity(node, op, ents)
        conn = get_connector(_conn(connectors, ent))
        kp = cfg.get("key_param") or ent.primary_key
        inputs = state["inputs"]
        key = inputs.get(kp)
        values = {f: inputs[f] for f in cfg.get("allowed_fields", []) if f in inputs}
        values.update(cfg.get("set_values") or {})  # fixed values defined at design time, e.g. status=suspended
        if not values:
            raise _Stop(422, {"error": "validation_failed", "reason": "No updatable fields supplied"})
        row = conn.update(ent.resource, ent.primary_key, key, values, _where(ent, principal, state))
        state["_detail"] = f"updated {list(values)}" if row else "no matching row"
        return ("record", row, None) if row else ("empty", None, None)

    if t == "database.insert":
        ent = _entity(node, op, ents)
        conn = get_connector(_conn(connectors, ent))
        inputs = state["inputs"]
        values = {f: inputs[f] for f in cfg.get("allowed_fields", []) if f in inputs}
        if ent.tenant_key:
            values[ent.tenant_key] = principal.tenant  # tenant always comes from trusted context
        row = conn.insert(ent.resource, values)
        return "record", row, None

    if t == "data.redact":
        ent = _entity(node, op, ents)
        deny = {f.name for f in ent.fields if not f.exposed} | set(cfg.get("extra_deny", []))
        masks = {f.name: f.masked_unless_scope for f in ent.fields if f.masked_unless_scope}
        masked_count = 0

        def red(r):
            nonlocal masked_count
            if not isinstance(r, dict):
                return r
            out = {}
            for k, v in r.items():
                if k in deny:
                    continue
                sc = masks.get(k)
                if sc and sc not in principal.scopes:
                    out[k] = mask_value(v)
                    masked_count += 1
                else:
                    out[k] = v
            return out
        res = [red(r) for r in payload] if isinstance(payload, list) else red(payload)
        state["_detail"] = f"removed {len(deny)} field(s), masked {masked_count} value(s)"
        return "out", res, None

    if t == "logic.condition":
        v = payload.get(cfg.get("field")) if isinstance(payload, dict) else None
        op_ = cfg.get("op", "eq")
        tgt = cfg.get("value")
        ok = {"eq": str(v) == str(tgt), "neq": str(v) != str(tgt), "exists": v is not None,
              "gt": _num(v) > _num(tgt), "lt": _num(v) < _num(tgt)}.get(op_, False)
        return ("true" if ok else "false"), payload, None

    if t == "transform.map":
        mp = cfg.get("mapping") or {}

        def m(r):
            return {k: (r.get(v) if isinstance(r, dict) else None) for k, v in mp.items()}
        return "out", ([m(r) for r in payload] if isinstance(payload, list) else m(payload or {})), None

    if t == "http.request":
        url = cfg.get("url", "")
        for k, v in state["inputs"].items():
            url = url.replace("{" + k + "}", str(v))
        host = urlparse(url).hostname or ""
        if "*" not in EGRESS_ALLOWLIST and host not in EGRESS_ALLOWLIST:
            raise _Stop(403, {"error": "egress_denied", "reason": f"{host} is not on the egress allowlist"})
        headers = {}
        if cfg.get("auth_secret_ref"):
            tok = vault.get(cfg["auth_secret_ref"])
            if tok:
                headers["Authorization"] = f"Bearer {tok}"
        try:
            r = httpx.request(cfg.get("method", "GET"), url, headers=headers, timeout=op.timeout_ms / 1000,
                              json=payload if cfg.get("method", "GET") != "GET" else None)
            body = r.json() if "json" in r.headers.get("content-type", "") else {"text": r.text[:4000]}
            state["_detail"] = f"{r.status_code} from {host}"
            return ("out" if r.status_code < 400 else "error"), body, None
        except httpx.HTTPError as e:
            state["_detail"] = str(e)[:200]
            return "error", {"error": "upstream_unavailable"}, None

    if t == "ai.model_call":
        from ..ai.llm import complete_text, get_provider
        prov = get_provider(cfg.get("provider_id"))
        if not prov:
            raise _Stop(500, {"error": "provider_not_found"})
        data_class = spec.capability.classification
        if CLASS_RANK[data_class] > CLASS_RANK.get(prov.get("data_classification_max", "internal"), 1):
            raise _Stop(403, {"error": "provider_not_approved",
                              "reason": f"{data_class} data cannot be sent to provider {prov['name']}"})
        prompt = cfg.get("prompt", "").replace("{{payload}}", json.dumps(payload, default=str)[:8000])
        text = complete_text(prov, [{"role": "user", "content": prompt}], system="You are a data processing step. Be concise.")
        field = cfg.get("output_field") or "ai_output"
        out = dict(payload) if isinstance(payload, dict) else {"items": payload}
        out[field] = text
        return "out", out, None

    if t == "output.response":
        status = int(cfg.get("status") or (201 if op.side_effect == "write" and any(n.type == "database.insert" for n in op.workflow.nodes) else 200))
        return "out", payload, (status, payload)

    if t == "output.error":
        body: dict[str, Any] = {"error": cfg.get("message") or "error"}
        dec = state.get("decision")
        if dec is not None and not dec.allow:
            body["reason"] = dec.reason
        if state.get("validation_errors"):
            body["details"] = state["validation_errors"]
        return "out", payload, (int(cfg.get("status") or 400), body)

    raise _Stop(500, {"error": "unsupported_node", "reason": t})


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def _conn(connectors: dict[str, dict], ent: EntitySpec) -> dict:
    c = connectors.get(ent.connector_ref)
    if not c:
        raise _Stop(502, {"error": "connector_not_found", "reason": ent.connector_ref})
    if c.get("status") == "disabled":
        raise _Stop(503, {"error": "connector_disabled"})
    return c
