"""Data-plane gateway: REST, GraphQL and MCP interfaces over deployed capabilities.

URL layout (one gateway per environment):

  REST     /gw/{env}/{project_slug}/api/{path}
  GraphQL  /gw/{env}/{project_slug}/graphql
  MCP      /gw/{env}/mcp/{server_slug}            (Streamable HTTP, JSON responses)

Layer 1 authenticates the caller and attaches a trusted principal. The
operation policy, tenant filters and redaction run in the shared executor.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from graphql import (FieldNode, GraphQLError, OperationDefinitionNode, build_schema, graphql_sync, parse)

from .. import db
from ..config import ORG_ID
from ..ir.projections import graphql_sdl
from ..services import (ENVIRONMENTS, client_by_token, connectors_map, deployed_specs, principal_for, project_by_slug,
                        rate_limiter)
from .executor import execute
from .policy import Principal

router = APIRouter(prefix="/gw", tags=["gateway"])

MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
GQL_MAX_DEPTH = 6
GQL_MAX_ALIASES = 15


def _auth(request: Request, environment: str, project_id: str | None) -> tuple[Principal | None, dict | None, str | None]:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None, None, "missing_token"
    client = client_by_token(auth.split(" ", 1)[1].strip())
    if not client:
        return None, None, "invalid_token"
    if environment not in client.get("environments", []):
        return None, client, "environment_not_permitted"
    if project_id and client.get("project_ids") and project_id not in client["project_ids"]:
        return None, client, "project_not_permitted"
    return principal_for(client), client, None


def _trace(project_id, interface, env, op, client, status, t0, spans):
    tid = db.add_trace(ORG_ID, project_id, interface, env, op, client, status, int((time.perf_counter() - t0) * 1000), spans)
    return tid


def _match(path_tpl: str, path: str) -> dict | None:
    rx = "^" + re.sub(r"{(\w+)}", r"(?P<\1>[^/]+)", path_tpl.rstrip("/")) + "/?$"
    m = re.match(rx, "/" + path.strip("/"))
    return m.groupdict() if m else None


# --------------------------------------------------------------------------- REST

@router.api_route("/{env}/{project_slug}/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def rest_gateway(env: str, project_slug: str, path: str, request: Request):
    t0 = time.perf_counter()
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    if env not in ENVIRONMENTS:
        return JSONResponse({"error": "unknown_environment"}, 404)
    project = project_by_slug(project_slug)
    if not project:
        return JSONResponse({"error": "unknown_project"}, 404)
    principal, client, err = _auth(request, env, project["id"])
    if err:
        _trace(project["id"], "rest", env, f"{request.method} /{path}", client.get("name") if client else None, 401, t0,
               [{"node_id": "gateway", "type": "gateway.auth", "label": "Authenticate", "status": "stopped", "detail": err}])
        db.audit(ORG_ID, client.get("name") if client else "anonymous", "gateway.auth", outcome="deny",
                 actor_type="client", project_id=project["id"], details={"reason": err, "path": path})
        return JSONResponse({"error": "unauthorized", "reason": err}, 401, headers={"x-request-id": rid})

    for cap, rev in deployed_specs(project["id"], env):
        for op in rev["spec"]["operations"]:
            for itf in op["interfaces"]:
                if itf["kind"] != "rest" or not itf.get("enabled", True) or (itf.get("method") or "").upper() != request.method:
                    continue
                params = _match(itf.get("path") or "", path)
                if params is None:
                    continue
                if not rate_limiter.allow(f"{principal.client_id}:{op['id']}", op.get("rate_limit_per_minute", 600)):
                    return JSONResponse({"error": "rate_limited"}, 429)
                inputs: dict[str, Any] = dict(request.query_params)
                inputs.update(params)
                if request.method in ("POST", "PUT", "PATCH"):
                    try:
                        body = await request.json()
                        if isinstance(body, dict):
                            inputs.update(body)
                    except (json.JSONDecodeError, ValueError):
                        pass
                res = execute(rev["spec"], op["id"], principal, inputs, environment=env, interface="rest",
                              connectors=connectors_map(), project_id=project["id"], capability_id=cap["id"], revision_id=rev["id"])
                spans = [{"node_id": "gateway", "type": "gateway.auth", "label": f"Authenticated {principal.client_name}",
                          "status": "ok", "detail": f"scopes: {', '.join(principal.scopes)}"}] + res.spans
                tid = _trace(project["id"], "rest", env, op["id"], principal.client_name, res.status, t0, spans)
                return JSONResponse(res.body, res.status, headers={"x-request-id": rid, "x-apf-trace": tid,
                                                                   "x-apf-revision": str(rev["number"])})
    return JSONResponse({"error": "not_found", "reason": f"No deployed operation for {request.method} /{path} in {env}"}, 404)


# --------------------------------------------------------------------------- GraphQL

def _depth(node, frags, d=0) -> int:
    sel = getattr(node, "selection_set", None)
    if not sel:
        return d
    best = d
    for s in sel.selections:
        if s.kind == "fragment_spread":
            f = frags.get(s.name.value)
            best = max(best, _depth(f, frags, d) if f else d)
        else:
            best = max(best, _depth(s, frags, d + 1))
    return best


def _aliases(node) -> int:
    sel = getattr(node, "selection_set", None)
    if not sel:
        return 0
    n = 0
    for s in sel.selections:
        if isinstance(s, FieldNode) and s.alias:
            n += 1
        n += _aliases(s)
    return n


def build_graphql(project_id: str, env: str):
    specs = deployed_specs(project_id, env)
    sdl = graphql_sdl([rev["spec"] for _, rev in specs]) if specs else "type Query { _empty: String }\n"
    schema = build_schema(sdl)
    mapping: dict[tuple[str, str], tuple[dict, dict, dict]] = {}
    for cap, rev in specs:
        for op in rev["spec"]["operations"]:
            for itf in op["interfaces"]:
                if itf["kind"] == "graphql" and itf.get("enabled", True) and itf.get("field"):
                    root = "Query" if op["side_effect"] == "read" else "Mutation"
                    mapping[(root, itf["field"])] = (cap, rev, op)
    return schema, sdl, mapping


@router.post("/{env}/{project_slug}/graphql")
async def graphql_gateway(env: str, project_slug: str, request: Request):
    t0 = time.perf_counter()
    project = project_by_slug(project_slug)
    if not project or env not in ENVIRONMENTS:
        return JSONResponse({"errors": [{"message": "Unknown project or environment"}]}, 404)
    principal, client, err = _auth(request, env, project["id"])
    if err:
        _trace(project["id"], "graphql", env, None, client.get("name") if client else None, 401, t0,
               [{"node_id": "gateway", "type": "gateway.auth", "label": "Authenticate", "status": "stopped", "detail": err}])
        return JSONResponse({"errors": [{"message": "Unauthorized", "extensions": {"code": "UNAUTHENTICATED", "reason": err}}]}, 401)
    body = await request.json()
    query = body.get("query", "")
    variables = body.get("variables") or {}
    try:
        doc = parse(query)
    except GraphQLError as e:
        return JSONResponse({"errors": [{"message": e.message}]}, 400)
    frags = {d.name.value: d for d in doc.definitions if d.kind == "fragment_definition"}
    for d in doc.definitions:
        if isinstance(d, OperationDefinitionNode):
            if _depth(d, frags) > GQL_MAX_DEPTH:
                return JSONResponse({"errors": [{"message": f"Query depth exceeds {GQL_MAX_DEPTH}", "extensions": {"code": "QUERY_TOO_DEEP"}}]}, 400)
            if _aliases(d) > GQL_MAX_ALIASES:
                return JSONResponse({"errors": [{"message": "Too many aliases", "extensions": {"code": "ALIAS_LIMIT"}}]}, 400)
    if env == "production" and ("__schema" in query or "__type" in query):
        return JSONResponse({"errors": [{"message": "Introspection is disabled in production", "extensions": {"code": "INTROSPECTION_DISABLED"}}]}, 400)

    schema, _, mapping = build_graphql(project["id"], env)
    all_spans: list[dict] = []
    statuses: list[int] = []

    def make_resolver(root: str, fname: str):
        def resolve(_root, info, **args):
            cap, rev, op = mapping[(root, fname)]
            if not rate_limiter.allow(f"{principal.client_id}:{op['id']}", op.get("rate_limit_per_minute", 600)):
                raise GraphQLError("Rate limited", extensions={"code": "RATE_LIMITED"})
            res = execute(rev["spec"], op["id"], principal, args, environment=env, interface="graphql",
                          connectors=connectors_map(), project_id=project["id"], capability_id=cap["id"], revision_id=rev["id"])
            all_spans.extend(res.spans)
            statuses.append(res.status)
            if res.status == 202:
                return json.dumps(res.body)
            if res.status == 404:
                return None
            if res.status >= 400:
                code = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 422: "BAD_USER_INPUT", 429: "RATE_LIMITED"}.get(res.status, "INTERNAL")
                reason = res.body.get("reason") if isinstance(res.body, dict) else None
                raise GraphQLError(f"{code}: {reason or res.body.get('error', '')}", extensions={"code": code})
            return res.body
        return resolve

    for (root, fname) in mapping:
        t = schema.query_type if root == "Query" else schema.mutation_type
        if t and fname in t.fields:
            t.fields[fname].resolve = make_resolver(root, fname)
    result = graphql_sync(schema, query, variable_values=variables)
    out: dict[str, Any] = {"data": result.data}
    if result.errors:
        out["errors"] = [e.formatted for e in result.errors]
    status = max(statuses) if statuses else (400 if result.errors else 200)
    _trace(project["id"], "graphql", env, "graphql", principal.client_name, status if status != 202 else 202, t0,
           [{"node_id": "gateway", "type": "gateway.auth", "label": f"Authenticated {principal.client_name}", "status": "ok", "detail": ""}] + all_spans)
    return JSONResponse(out, 200)


@router.get("/{env}/{project_slug}/graphql/schema")
async def graphql_schema(env: str, project_slug: str):
    project = project_by_slug(project_slug)
    if not project:
        return JSONResponse({"error": "unknown_project"}, 404)
    if env == "production":
        return JSONResponse({"error": "schema download disabled in production"}, 403)
    _, sdl, _ = build_graphql(project["id"], env)
    return Response(sdl, media_type="text/plain")


# --------------------------------------------------------------------------- MCP

def _mcp_server(slug: str) -> dict | None:
    return next((s for s in db.list_records("mcp_server", ORG_ID) if s.get("slug") == slug), None)


def mcp_tool_index(server: dict, env: str) -> dict[str, tuple[dict, dict, dict, dict]]:
    """tool_name -> (capability, revision, operation, tool_definition) for tools deployed in env."""
    from ..ir.projections import mcp_tools
    wanted = set(server.get("tool_operation_ids", []))
    idx = {}
    for cap, rev in deployed_specs(server["project_id"], env):
        tools = {t["_meta"]["apf/operation"]: t for t in mcp_tools(rev["spec"])}
        for op in rev["spec"]["operations"]:
            key = f"{cap['id']}:{op['id']}"
            if key in wanted and op["id"] in tools:
                idx[tools[op["id"]]["name"]] = (cap, rev, op, tools[op["id"]])
    return idx


def _rpc(id_, result=None, error=None):
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": id_}
    if error:
        msg["error"] = error
    else:
        msg["result"] = result
    return msg


@router.get("/{env}/mcp/{server_slug}")
async def mcp_get(env: str, server_slug: str):
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("/{env}/mcp/{server_slug}")
async def mcp_gateway(env: str, server_slug: str, request: Request):
    t0 = time.perf_counter()
    server = _mcp_server(server_slug)
    if not server or env not in ENVIRONMENTS:
        return JSONResponse({"error": "unknown_mcp_server"}, 404)
    principal, client, err = _auth(request, env, server["project_id"])
    if err:
        db.audit(ORG_ID, client.get("name") if client else "anonymous", "mcp.auth", outcome="deny", actor_type="client",
                 project_id=server["project_id"], details={"reason": err, "server": server_slug})
        return JSONResponse({"error": "unauthorized", "reason": err}, 401,
                            headers={"WWW-Authenticate": 'Bearer realm="apification-mcp"'})
    if server.get("allowed_client_ids") and principal.client_id not in server["allowed_client_ids"]:
        db.audit(ORG_ID, principal.client_name or "", "mcp.discovery", outcome="deny", actor_type=principal.kind,
                 project_id=server["project_id"], details={"server": server_slug})
        return JSONResponse({"error": "forbidden", "reason": "Client is not allowed to use this MCP server"}, 403)
    try:
        msg = await request.json()
    except (json.JSONDecodeError, ValueError):
        return JSONResponse(_rpc(None, error={"code": -32700, "message": "Parse error"}), 400)
    batch = msg if isinstance(msg, list) else [msg]
    replies = []
    for m in batch:
        r = _mcp_handle(m, server, env, principal, t0)
        if r is not None:
            replies.append(r)
    if not replies:
        return Response(status_code=202)
    headers = {}
    if any(m.get("method") == "initialize" for m in batch):
        headers["Mcp-Session-Id"] = uuid.uuid4().hex
    return JSONResponse(replies if isinstance(msg, list) else replies[0], headers=headers)


def _mcp_handle(m: dict, server: dict, env: str, principal: Principal, t0: float):
    method = m.get("method", "")
    mid = m.get("id")
    if mid is None:  # notification
        return None
    if method == "initialize":
        req_v = (m.get("params") or {}).get("protocolVersion")
        return _rpc(mid, {"protocolVersion": req_v if req_v in MCP_VERSIONS else MCP_VERSIONS[0],
                          "capabilities": {"tools": {"listChanged": False}},
                          "serverInfo": {"name": server["name"], "version": str(server.get("version", 1))},
                          "instructions": server.get("description") or "Governed tools published by APIfication."})
    if method == "ping":
        return _rpc(mid, {})
    if method == "tools/list":
        idx = mcp_tool_index(server, env)
        tools = []
        for name, (_, _, _, tdef) in idx.items():
            tools.append({k: v for k, v in tdef.items() if k != "_meta"} | {"_meta": {"apf/scopes": tdef["_meta"]["apf/scopes"]}})
        return _rpc(mid, {"tools": tools})
    if method == "tools/call":
        params = m.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        idx = mcp_tool_index(server, env)
        if name not in idx:
            return _rpc(mid, error={"code": -32602, "message": f"Unknown tool: {name}"})
        cap, rev, op, _ = idx[name]
        if not rate_limiter.allow(f"{principal.client_id}:{op['id']}", op.get("rate_limit_per_minute", 600)):
            return _rpc(mid, {"content": [{"type": "text", "text": "Rate limited"}], "isError": True})
        res = execute(rev["spec"], op["id"], principal, args, environment=env, interface="mcp",
                      connectors=connectors_map(), project_id=server["project_id"], capability_id=cap["id"], revision_id=rev["id"])
        _trace(server["project_id"], "mcp", env, f"{server['slug']}/{name}", principal.client_name, res.status, t0,
               [{"node_id": "gateway", "type": "gateway.auth", "label": f"Authenticated {principal.client_name}", "status": "ok",
                 "detail": f"MCP server {server['slug']}"}] + res.spans)
        db.audit(ORG_ID, principal.client_name or principal.subject, "mcp.tool.call", actor_type=principal.kind,
                 resource=f"{server['slug']}/{name}", outcome="success" if res.status < 400 else "deny",
                 project_id=server["project_id"], details={"status": res.status})
        if res.status >= 400:
            reason = res.body.get("reason") or res.body.get("error") if isinstance(res.body, dict) else str(res.body)
            return _rpc(mid, {"content": [{"type": "text", "text": f"Denied ({res.status}): {reason}"}], "isError": True})
        structured = res.body if isinstance(res.body, dict) else {"items": res.body}
        return _rpc(mid, {"content": [{"type": "text", "text": json.dumps(res.body, default=str)}],
                          "structuredContent": structured, "isError": False})
    return _rpc(mid, error={"code": -32601, "message": f"Method not found: {method}"})
