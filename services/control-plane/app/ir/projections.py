"""Generated projections of the canonical specification.

REST (OpenAPI 3.1), GraphQL SDL, MCP tool definitions and OPA Rego policies
are all derived from the same CCS, so a permission change in the spec is
reflected in every interface at once.
"""
from __future__ import annotations

import json
import re
from typing import Any

from ..models import CapabilitySpec, EntitySpec, OperationSpec

JSON_TYPES = {"string": "string", "integer": "integer", "number": "number", "boolean": "boolean",
              "datetime": "string", "json": "object"}
GQL_TYPES = {"string": "String", "integer": "Int", "number": "Float", "boolean": "Boolean", "datetime": "String", "json": "String"}


def _pascal(s: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^A-Za-z0-9]", s) if p)


def entity_schema(ent: EntitySpec) -> dict[str, Any]:
    props = {}
    for f in ent.fields:
        if not f.exposed:
            continue
        p: dict[str, Any] = {"type": JSON_TYPES.get(f.type, "string")}
        if f.type == "datetime":
            p["format"] = "date-time"
        desc = f.description or ""
        if f.masked_unless_scope:
            desc = (desc + " " if desc else "") + f"Masked unless caller holds `{f.masked_unless_scope}`."
        if desc:
            p["description"] = desc
        p["x-classification"] = f.classification
        props[f.name] = p
    return {"type": "object", "properties": props}


def _param_schema(p) -> dict:
    s: dict[str, Any] = {"type": JSON_TYPES.get(p.type, "string")}
    if p.max_length:
        s["maxLength"] = p.max_length
    return s


def openapi(spec_dict: dict, server_url: str = "") -> dict[str, Any]:
    spec = CapabilitySpec.model_validate(spec_dict)
    ents = {e.name: e for e in spec.entities}
    paths: dict[str, Any] = {}
    for op in spec.operations:
        for itf in op.interfaces:
            if itf.kind != "rest" or not itf.enabled or not itf.path or not itf.method:
                continue
            params = [{"name": p.name, "in": p.location, "required": p.required or p.location == "path",
                       "description": p.description, "schema": _param_schema(p)}
                      for p in op.params if p.location in ("path", "query")]
            body_params = [p for p in op.params if p.location == "body"]
            ent = ents.get(op.entity or "")
            ref = {"$ref": f"#/components/schemas/{ent.name}"} if ent else {"type": "object"}
            ok_schema = {"type": "array", "items": ref} if op.returns == "many" else ref
            item: dict[str, Any] = {
                "operationId": op.id, "summary": op.name, "description": op.description,
                "tags": [spec.capability.name],
                "parameters": params,
                "security": [{"oauth2": op.required_scopes}],
                "x-apf-policy": op.policy_ref, "x-apf-side-effect": op.side_effect,
                "responses": {
                    "200": {"description": "Success", "content": {"application/json": {"schema": ok_schema}}},
                    "401": {"$ref": "#/components/responses/Unauthorized"},
                    "403": {"$ref": "#/components/responses/Forbidden"},
                    "404": {"description": "Not found or not visible to the caller"},
                    "422": {"$ref": "#/components/responses/ValidationError"},
                },
            }
            if op.approval_required:
                item["responses"]["202"] = {"description": "Accepted — pending approval",
                                            "content": {"application/json": {"schema": {"type": "object", "properties": {
                                                "approval_id": {"type": "string"}, "status": {"type": "string"}}}}}}
            if body_params:
                item["requestBody"] = {"required": True, "content": {"application/json": {"schema": {
                    "type": "object", "properties": {p.name: _param_schema(p) for p in body_params},
                    "required": [p.name for p in body_params if p.required]}}}}
            paths.setdefault(itf.path, {})[itf.method.lower()] = item
    all_scopes = {s.name: s.description or s.name for s in spec.scopes}
    return {
        "openapi": "3.1.0",
        "info": {"title": spec.capability.name, "description": spec.capability.description, "version": "1.0.0",
                 "x-apf-capability": spec.capability.id},
        "servers": [{"url": server_url}] if server_url else [],
        "paths": paths,
        "components": {
            "schemas": {e.name: entity_schema(e) for e in spec.entities},
            "securitySchemes": {"oauth2": {"type": "oauth2", "flows": {"clientCredentials": {
                "tokenUrl": "/oauth/token", "scopes": all_scopes}}}},
            "responses": {
                "Unauthorized": {"description": "Missing or invalid credentials"},
                "Forbidden": {"description": "Policy denied the operation"},
                "ValidationError": {"description": "Request failed validation"},
            },
        },
    }


def graphql_sdl(specs: list[dict]) -> str:
    """Build one SDL document from one or more capability specs (one GraphQL service per project/env)."""
    types: list[str] = []
    queries: list[str] = []
    mutations: list[str] = []
    seen_types: set[str] = set()
    for sd in specs:
        spec = CapabilitySpec.model_validate(sd)
        ents = {e.name: e for e in spec.entities}
        for ent in spec.entities:
            tname = _pascal(ent.name)
            if tname in seen_types:
                continue
            seen_types.add(tname)
            fields = []
            for f in ent.fields:
                if not f.exposed:
                    continue
                note = f'  """{f.classification}{"; masked unless " + f.masked_unless_scope if f.masked_unless_scope else ""}"""\n'
                fields.append(note + f"  {f.name}: {GQL_TYPES.get(f.type, 'String')}")
            types.append(f'"""{ent.name} ({ent.resource})"""\ntype {tname} {{\n' + "\n".join(fields) + "\n}")
        for op in spec.operations:
            for itf in op.interfaces:
                if itf.kind != "graphql" or not itf.enabled or not itf.field:
                    continue
                args = []
                for p in op.params:
                    t = GQL_TYPES.get(p.type, "String") + ("!" if p.required or p.location == "path" else "")
                    args.append(f"{p.name}: {t}")
                ent = ents.get(op.entity or "")
                rt = _pascal(ent.name) if ent else "String"
                ret = f"[{rt}!]!" if op.returns == "many" else rt
                if op.approval_required:
                    ret = "String"
                desc = (op.description or op.name).replace('"', "'")
                line = f'  """{desc} — requires {", ".join(op.required_scopes) or "policy"}"""\n  {itf.field}' + (f"({', '.join(args)})" if args else "") + f": {ret}"
                (queries if op.side_effect == "read" else mutations).append(line)
    sdl = "\n\n".join(types)
    sdl += "\n\ntype Query {\n" + ("\n".join(queries) if queries else "  _empty: String") + "\n}"
    if mutations:
        sdl += "\n\ntype Mutation {\n" + "\n".join(mutations) + "\n}"
    return sdl + "\n"


def mcp_tools(spec_dict: dict) -> list[dict[str, Any]]:
    spec = CapabilitySpec.model_validate(spec_dict)
    ents = {e.name: e for e in spec.entities}
    tools = []
    for op in spec.operations:
        for itf in op.interfaces:
            if itf.kind != "mcp" or not itf.enabled or not itf.tool_name:
                continue
            props = {p.name: {**_param_schema(p), "description": p.description or p.name} for p in op.params}
            ent = ents.get(op.entity or "")
            out = entity_schema(ent) if ent else {"type": "object"}
            if op.returns == "many":
                out = {"type": "object", "properties": {"items": {"type": "array", "items": out}}}
            tools.append({
                "name": itf.tool_name,
                "title": op.name,
                "description": op.description or op.name,
                "inputSchema": {"type": "object", "properties": props,
                                "required": [p.name for p in op.params if p.required or p.location == "path"]},
                "outputSchema": out,
                "annotations": {"readOnlyHint": op.side_effect == "read",
                                "destructiveHint": op.side_effect == "destructive",
                                "idempotentHint": op.side_effect == "read"},
                "_meta": {"apf/capability": spec.capability.id, "apf/operation": op.id,
                          "apf/scopes": op.required_scopes, "apf/policy": op.policy_ref,
                          "apf/approval_required": op.approval_required},
            })
    return tools


def rego(spec_dict: dict) -> str:
    """OPA Rego bundle equivalent of the built-in policy engine."""
    spec = CapabilitySpec.model_validate(spec_dict)
    pkg = re.sub(r"[^a-z0-9_]", "_", spec.capability.id.lower())
    out = [f"package apf.{pkg}", "", "import rego.v1", "", "default allow := false", ""]
    for p in spec.policies:
        pid = re.sub(r"[^a-z0-9_]", "_", p.id.lower())
        out.append(f"# {p.name} (v{p.version}) — {p.description}")
        out.append(f"allow if {{\n  input.policy == \"{p.id}\"")
        if p.roles:
            out.append(f"  some role in input.principal.roles\n  role in {json.dumps(sorted(p.roles))}")
        for s in p.scopes:
            out.append(f"  \"{s}\" in input.principal.scopes")
        for c in p.conditions:
            attr = "input." + c.attribute
            if c.op == "eq":
                out.append(f"  {attr} == {json.dumps(c.value)}")
            elif c.op == "neq":
                out.append(f"  {attr} != {json.dumps(c.value)}")
            elif c.op == "in":
                out.append(f"  {attr} in {json.dumps(c.value)}")
            else:
                out.append(f"  not {attr} in {json.dumps(c.value)}")
        out.append("}\n")
        if p.row_filters:
            out.append(f"row_filters[\"{pid}\"] := {json.dumps([rf.model_dump() for rf in p.row_filters])}\n")
    return "\n".join(out)
