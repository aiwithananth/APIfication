"""Deterministic validation of the Canonical Capability Specification.

AI proposes, validators decide (product principle). A revision can only be
released when `validate()` returns no errors.
"""
from __future__ import annotations

import hashlib
import re
from collections import defaultdict, deque
from typing import Any

from pydantic import ValidationError

from ..db import dumps
from ..models import CapabilitySpec
from .nodes import ENTRY_NODES, NODE_TYPES, OUTPUT_NODES, WRITE_NODES

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bghp_[A-Za-z0-9]{30,}"),
    re.compile(r"(?i)\b(password|passwd|pwd|api[_-]?key|secret)\s*[:=]\s*['\"]?[^\s'\"$]{6,}"),
    re.compile(r"(?i)postgres(ql)?://[^:\s]+:[^@\s]+@"),
]
DATA_NODES = {"database.select", "database.update", "database.insert", "http.request", "ai.model_call"}


def digest(spec: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(dumps(spec).encode()).hexdigest()


def _issue(level: str, code: str, message: str, operation_id: str | None = None, node_id: str | None = None) -> dict:
    return {"level": level, "code": code, "message": message, "operation_id": operation_id, "node_id": node_id}


def scan_secrets(obj: Any, path: str = "") -> list[str]:
    hits: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            hits += scan_secrets(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits += scan_secrets(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        if obj.startswith("secret://"):
            return hits
        for p in SECRET_PATTERNS:
            if p.search(obj):
                hits.append(path)
                break
    return hits


def validate(spec_dict: dict[str, Any], connectors: dict[str, dict] | None = None,
             environment: str = "development") -> dict[str, Any]:
    connectors = connectors or {}
    issues: list[dict] = []
    try:
        spec = CapabilitySpec.model_validate(spec_dict)
    except ValidationError as e:
        for err in e.errors():
            issues.append(_issue("error", "schema", f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}"))
        return _result(issues, spec_dict)

    policies = {p.id: p for p in spec.policies}
    scopes = {s.name for s in spec.scopes}
    entities = {e.name: e for e in spec.entities}
    role_names = {r.name for r in spec.roles}

    # ---- entities / connectors
    for ent in spec.entities:
        conn = connectors.get(ent.connector_ref)
        if connectors and not conn:
            issues.append(_issue("error", "connector.missing", f"Entity {ent.name} references unknown connector {ent.connector_ref}"))
        fnames = {f.name for f in ent.fields}
        if ent.primary_key not in fnames:
            issues.append(_issue("error", "entity.pk", f"Entity {ent.name}: primary key '{ent.primary_key}' is not a declared field"))
        for f in ent.fields:
            if f.classification == "restricted" and f.exposed and not f.masked_unless_scope:
                issues.append(_issue("warning", "classification.restricted_exposed",
                                     f"{ent.name}.{f.name} is restricted but exposed without a masking scope"))
            if f.masked_unless_scope and f.masked_unless_scope not in scopes:
                issues.append(_issue("error", "scope.undeclared", f"{ent.name}.{f.name} masking scope '{f.masked_unless_scope}' is not declared"))

    for p in spec.policies:
        for s in p.scopes:
            if s not in scopes:
                issues.append(_issue("error", "scope.undeclared", f"Policy {p.id} requires undeclared scope '{s}'"))
        for r in p.roles:
            if role_names and r not in role_names:
                issues.append(_issue("warning", "role.undeclared", f"Policy {p.id} references role '{r}' not in the role matrix"))
        if environment == "production" and any("*" in s for s in p.scopes):
            issues.append(_issue("error", "scope.wildcard", f"Policy {p.id} uses a wildcard scope in production"))

    seen_rest: dict[str, str] = {}
    seen_gql: dict[str, str] = {}
    seen_mcp: dict[str, str] = {}
    op_ids = set()

    for op in spec.operations:
        if op.id in op_ids:
            issues.append(_issue("error", "operation.duplicate", f"Duplicate operation id {op.id}", op.id))
        op_ids.add(op.id)

        if not op.policy_ref:
            issues.append(_issue("error", "policy.missing", f"Operation {op.id} has no explicit policy decision", op.id))
        elif op.policy_ref not in policies:
            issues.append(_issue("error", "policy.unknown", f"Operation {op.id} references unknown policy {op.policy_ref}", op.id))
        for s in op.required_scopes:
            if s not in scopes:
                issues.append(_issue("error", "scope.undeclared", f"Operation {op.id} requires undeclared scope '{s}'", op.id))
        if op.entity and op.entity not in entities:
            issues.append(_issue("error", "entity.unknown", f"Operation {op.id} references unknown entity {op.entity}", op.id))
        if op.side_effect != "read" and not op.required_scopes:
            issues.append(_issue("error", "scope.write_unscoped", f"Write operation {op.id} must require at least one scope", op.id))
        if op.side_effect == "destructive" and not op.approval_required:
            issues.append(_issue("error", "approval.destructive", f"Destructive operation {op.id} must require approval", op.id))

        # interfaces
        param_names = {p.name for p in op.params}
        for itf in op.interfaces:
            if not itf.enabled:
                continue
            if itf.kind == "rest":
                if not itf.method or not itf.path:
                    issues.append(_issue("error", "rest.incomplete", f"REST interface of {op.id} needs method and path", op.id))
                    continue
                key = f"{itf.method.upper()} {itf.path}"
                if key in seen_rest:
                    issues.append(_issue("error", "rest.conflict", f"{key} is used by both {seen_rest[key]} and {op.id}", op.id))
                seen_rest[key] = op.id
                for pp in re.findall(r"{(\w+)}", itf.path):
                    if pp not in param_names:
                        issues.append(_issue("error", "rest.path_param", f"Path parameter {{{pp}}} of {op.id} is not a declared parameter", op.id))
            elif itf.kind == "graphql":
                if not itf.field:
                    issues.append(_issue("error", "graphql.incomplete", f"GraphQL interface of {op.id} needs a field name", op.id))
                    continue
                if itf.field in seen_gql:
                    issues.append(_issue("error", "graphql.conflict", f"GraphQL field {itf.field} is used by {seen_gql[itf.field]} and {op.id}", op.id))
                seen_gql[itf.field] = op.id
                expected = "query" if op.side_effect == "read" else "mutation"
                if itf.operation and itf.operation != expected:
                    issues.append(_issue("error", "graphql.kind", f"{op.id} is {op.side_effect} but exposed as GraphQL {itf.operation}", op.id))
            elif itf.kind == "mcp":
                if not itf.tool_name:
                    issues.append(_issue("error", "mcp.incomplete", f"MCP interface of {op.id} needs a tool name", op.id))
                    continue
                if itf.tool_name in seen_mcp:
                    issues.append(_issue("error", "mcp.conflict", f"MCP tool {itf.tool_name} is used by {seen_mcp[itf.tool_name]} and {op.id}", op.id))
                seen_mcp[itf.tool_name] = op.id
                if op.side_effect != "read" and not op.approval_required:
                    issues.append(_issue("warning", "mcp.write_unapproved", f"MCP tool {itf.tool_name} has side effects but no approval checkpoint", op.id))
                if not op.description:
                    issues.append(_issue("warning", "mcp.description", f"MCP tool {itf.tool_name} has no description for agents", op.id))

        issues += _validate_graph(op, entities, connectors, policies)

    for hit in scan_secrets(spec_dict):
        issues.append(_issue("error", "secret.inline", f"Possible secret value embedded at {hit}. Use a secret reference."))

    return _result(issues, spec_dict)


def _validate_graph(op, entities, connectors, policies) -> list[dict]:
    issues: list[dict] = []
    wf = op.workflow
    nodes = {}
    for n in wf.nodes:
        if n.id in nodes:
            issues.append(_issue("error", "graph.duplicate_node", f"Duplicate node id {n.id}", op.id, n.id))
        nodes[n.id] = n
        nt = NODE_TYPES.get(n.type)
        if not nt:
            issues.append(_issue("error", "graph.unknown_type", f"Unknown node type {n.type}", op.id, n.id))
            continue
        for fld in nt["config"]:
            if fld.get("required") and n.config.get(fld["key"]) in (None, "", []):
                issues.append(_issue("error", "node.config", f"{nt['label']} '{n.label or n.id}' is missing '{fld['label']}'", op.id, n.id))
        if n.type == "security.authorize":
            ref = n.config.get("policy_ref")
            if ref and ref not in policies:
                issues.append(_issue("error", "policy.unknown", f"Authorize node references unknown policy {ref}", op.id, n.id))
        ent_name = n.config.get("entity")
        if ent_name:
            ent = entities.get(ent_name)
            if not ent:
                issues.append(_issue("error", "entity.unknown", f"Node references unknown entity {ent_name}", op.id, n.id))
            elif n.type in WRITE_NODES:
                if op.side_effect == "read":
                    issues.append(_issue("error", "graph.write_in_read", f"Write node in read-only operation {op.id}", op.id, n.id))
                conn = connectors.get(ent.connector_ref)
                if conn and conn.get("read_only", True):
                    issues.append(_issue("error", "connector.read_only",
                                         f"Connector '{conn.get('name')}' is read-only. Approve write access before using {n.type}.", op.id, n.id))
                fields = {f.name: f for f in ent.fields}
                if not n.config.get("allowed_fields") and not n.config.get("set_values"):
                    issues.append(_issue("error", "node.config", f"'{n.label or n.id}' must declare updatable fields or fixed values", op.id, n.id))
                for af in [*n.config.get("allowed_fields", []), *(n.config.get("set_values") or {}).keys()]:
                    if af not in fields:
                        issues.append(_issue("error", "field.unknown", f"Unknown field {af} in allowed_fields", op.id, n.id))
                    elif not fields[af].writable:
                        issues.append(_issue("error", "field.not_writable", f"{ent.name}.{af} is not marked writable", op.id, n.id))

    if not wf.nodes:
        issues.append(_issue("error", "graph.empty", f"Operation {op.id} has no workflow", op.id))
        return issues

    out_edges: dict[str, list] = defaultdict(list)
    indeg: dict[str, int] = {nid: 0 for nid in nodes}
    for e in wf.edges:
        if e.source not in nodes or e.target not in nodes:
            issues.append(_issue("error", "graph.dangling_edge", f"Edge {e.source}→{e.target} references a missing node", op.id))
            continue
        st, tt = NODE_TYPES.get(nodes[e.source].type), NODE_TYPES.get(nodes[e.target].type)
        if st and e.source_port not in st["outputs"]:
            issues.append(_issue("error", "graph.port", f"{nodes[e.source].type} has no output port '{e.source_port}'", op.id, e.source))
        if tt and e.target_port not in tt["inputs"]:
            issues.append(_issue("error", "graph.port", f"{nodes[e.target].type} has no input port '{e.target_port}'", op.id, e.target))
        out_edges[e.source].append(e)
        indeg[e.target] += 1

    entries = [n for n in wf.nodes if n.type in ENTRY_NODES]
    if len(entries) != 1:
        issues.append(_issue("error", "graph.entry", f"Operation {op.id} needs exactly one entry node (found {len(entries)})", op.id))
        return issues

    # cycle detection (Kahn)
    q = deque([nid for nid, d in indeg.items() if d == 0])
    seen = 0
    indeg2 = dict(indeg)
    while q:
        nid = q.popleft()
        seen += 1
        for e in out_edges[nid]:
            indeg2[e.target] -= 1
            if indeg2[e.target] == 0:
                q.append(e.target)
    if seen != len(nodes):
        issues.append(_issue("error", "graph.cycle", f"Workflow of {op.id} contains a cycle. Use bounded loop nodes instead.", op.id))
        return issues

    # reachability + security coverage: every data node must be reached only via an authorize 'allowed' port
    entry = entries[0]
    reach: set[str] = set()
    visited: set[tuple[str, bool]] = set()
    stack = [(entry.id, False)]
    unguarded: set[str] = set()
    while stack:
        nid, guarded = stack.pop()
        if (nid, guarded) in visited:
            continue
        visited.add((nid, guarded))
        node = nodes[nid]
        if node.type in DATA_NODES and not guarded:
            unguarded.add(nid)
        reach.add(nid)
        for e in out_edges[nid]:
            g = guarded or (node.type == "security.authorize" and e.source_port == "allowed")
            stack.append((e.target, g))
    for nid in unguarded:
        issues.append(_issue("error", "security.unguarded",
                             f"'{nodes[nid].label or nid}' can be reached without passing an Authorize node", op.id, nid))
    for nid, n in nodes.items():
        if nid not in reach:
            issues.append(_issue("warning", "graph.unreachable", f"'{n.label or nid}' is not reachable from the entry", op.id, nid))
    if not any(nodes[n].type in OUTPUT_NODES for n in reach):
        issues.append(_issue("error", "graph.no_output", f"Workflow of {op.id} never reaches a Response node", op.id))
    if not any(nodes[n].type == "security.authorize" for n in reach):
        issues.append(_issue("error", "security.no_authorize", f"Operation {op.id} has no Authorize node", op.id))
    if op.approval_required and not any(nodes[n].type == "security.approval" for n in reach):
        issues.append(_issue("error", "approval.node_missing", f"{op.id} requires approval but has no Approval checkpoint", op.id))
    return issues


def _result(issues: list[dict], spec_dict: dict) -> dict:
    errors = [i for i in issues if i["level"] == "error"]
    warnings = [i for i in issues if i["level"] == "warning"]
    return {"valid": not errors, "errors": errors, "warnings": warnings, "digest": digest(spec_dict),
            "summary": f"{len(errors)} error(s), {len(warnings)} warning(s)"}
