"""Test generation and execution (section 18).

Generates positive, negative, role-matrix, tenant-isolation, redaction,
injection and validation tests from the canonical spec, then runs them
through the same executor used by the gateway.
"""
from __future__ import annotations

import time
from typing import Any

from . import db
from .config import ORG_ID
from .connectors import get_connector
from .models import CapabilitySpec, TestCase
from .runtime.executor import execute
from .runtime.policy import Principal
from .services import connectors_map


def _sample(spec: CapabilitySpec, ent_name: str | None, connectors: dict) -> tuple[dict | None, str | None]:
    """Pick a fixture row (development connectors only) to drive positive tests."""
    ent = next((e for e in spec.entities if e.name == ent_name), None)
    if not ent:
        return None, None
    conn = connectors.get(ent.connector_ref)
    if not conn or conn.get("environment") != "development":
        return None, None
    try:
        rows = get_connector(conn).select(ent.resource, [], [], limit=1)
    except Exception:  # noqa: BLE001
        return None, None
    if not rows:
        return None, None
    return rows[0], (rows[0].get(ent.tenant_key) if ent.tenant_key else None)


def generate_tests(spec_dict: dict, connectors: dict | None = None) -> list[dict]:
    spec = CapabilitySpec.model_validate(spec_dict)
    connectors = connectors if connectors is not None else connectors_map()
    policies = {p.id: p for p in spec.policies}
    tests: list[TestCase] = []
    for op in spec.operations:
        pol = policies.get(op.policy_ref or "")
        ent = next((e for e in spec.entities if e.name == op.entity), None)
        row, tenant = _sample(spec, op.entity, connectors)
        role = pol.roles[0] if pol and pol.roles else "tester"
        scopes = list(dict.fromkeys([*(pol.scopes if pol else []), *op.required_scopes]))
        subject = "test-subject"
        # relationship filters: impersonate the owner of the sample row so positive tests can see it
        if pol and ent and row:
            for rf in pol.row_filters:
                if rf.equals == "$principal.subject" and (not rf.when_role or rf.when_role == role):
                    subject = str(row.get(rf.field, subject))
        good = {"roles": [role], "scopes": scopes, "tenant": tenant or "tenant-a", "subject": subject, "kind": "synthetic"}
        inputs: dict[str, Any] = {}
        for p in op.params:
            if p.location == "path" and row is not None and ent:
                inputs[p.name] = row.get(ent.primary_key)
        if op.side_effect != "read" and ent:
            for f in ent.fields:
                if f.writable and row is not None and f.name in {pp.name for pp in op.params}:
                    inputs[f.name] = row.get(f.name)
                    break
        n = 0

        def add(name, category, principal, inp, status, **kw):
            nonlocal n
            n += 1
            tests.append(TestCase(id=f"{op.id}-{n}", name=name, operation_id=op.id, category=category,
                                  principal=principal, input=inp, expect_status=status, **kw))

        ok_status = 202 if op.approval_required else 200
        if row is not None or op.returns == "many":
            add(f"{op.name}: authorised caller succeeds", "positive", good, inputs, ok_status)
        add(f"{op.name}: caller without scopes is denied", "negative", {**good, "scopes": []}, inputs, 403)
        if pol and pol.roles:
            add(f"{op.name}: unrelated role is denied", "role-matrix", {**good, "roles": ["unrelated_role"]}, inputs, 403)
            for r in spec.roles:
                if r.name not in pol.roles:
                    add(f"{op.name}: role '{r.name}' is denied", "role-matrix",
                        {**good, "roles": [r.name], "scopes": r.scopes}, inputs, 403)
        if ent and ent.tenant_key:
            if op.returns == "many":
                add(f"{op.name}: other tenant sees no rows", "tenant-isolation", {**good, "tenant": "tenant-other"},
                    inputs, 200, expect_max_rows=0)
            elif row is not None and op.side_effect == "read":
                add(f"{op.name}: other tenant cannot read record", "tenant-isolation", {**good, "tenant": "tenant-other"}, inputs, 404)
        if ent and op.side_effect == "read" and (row is not None or op.returns == "many"):
            hidden = [f.name for f in ent.fields if not f.exposed]
            masked = [f.name for f in ent.fields if f.masked_unless_scope and f.exposed]
            if hidden or masked:
                add(f"{op.name}: restricted fields are never returned", "redaction", good, inputs, 200,
                    expect_absent_fields=hidden, expect_masked_fields=masked)
        search = next((p for p in op.params if p.name in ("q", "query", "search")), None)
        if search:
            add(f"{op.name}: SQL injection in search is inert", "injection", good, {**inputs, search.name: "' OR 1=1 --"},
                200, expect_max_rows=0)
        if any(p.location == "path" for p in op.params):
            add(f"{op.name}: missing key is rejected", "validation", good, {}, 422)
    return [t.model_dump() for t in tests]


def run_tests(capability: dict, revision: dict, environment: str = "development", actor: str = "system") -> dict:
    spec = revision["spec"]
    tests = spec.get("tests") or generate_tests(spec)
    conns = connectors_map()
    results = []
    t_start = time.perf_counter()
    for t in tests:
        p = t["principal"]
        principal = Principal(subject=p.get("subject", "test"), kind="synthetic", roles=p.get("roles", []),
                              scopes=p.get("scopes", []), tenant=p.get("tenant"), client_name="test-runner")
        t0 = time.perf_counter()
        res = execute(spec, t["operation_id"], principal, t.get("input", {}), environment=environment,
                      interface=t.get("interface", "rest"), connectors=conns, project_id=capability["project_id"],
                      capability_id=capability["id"], revision_id=revision["id"])
        problems = []
        if res.status != t["expect_status"]:
            problems.append(f"expected status {t['expect_status']}, got {res.status}")
        rows = res.body if isinstance(res.body, list) else ([res.body] if isinstance(res.body, dict) and res.status < 300 else [])
        if t.get("expect_max_rows") is not None and isinstance(res.body, list) and len(res.body) > t["expect_max_rows"]:
            problems.append(f"expected at most {t['expect_max_rows']} rows, got {len(res.body)}")
        for r in rows:
            if not isinstance(r, dict):
                continue
            for f in t.get("expect_absent_fields", []):
                if f in r:
                    problems.append(f"field '{f}' must not be returned")
            for f in t.get("expect_masked_fields", []):
                if f in r and r[f] is not None and "•" not in str(r[f]):
                    problems.append(f"field '{f}' must be masked")
        if res.status == 202 and isinstance(res.body, dict) and res.body.get("approval_id"):
            # test-created approvals are discarded so they never reach approvers
            db.delete_record("approval", res.body["approval_id"])
        results.append({"id": t["id"], "name": t["name"], "category": t["category"], "operation_id": t["operation_id"],
                        "passed": not problems, "problems": problems, "status": res.status,
                        "ms": round((time.perf_counter() - t0) * 1000, 1)})
    passed = sum(1 for r in results if r["passed"])
    run = db.put_record("test_run", ORG_ID, {
        "name": f"{capability['name']} r{revision['number']}", "capability_id": capability["id"],
        "revision_id": revision["id"], "revision_number": revision["number"], "environment": environment,
        "project_id": capability["project_id"], "total": len(results), "passed": passed,
        "failed": len(results) - passed, "status": "passed" if passed == len(results) and results else "failed",
        "duration_ms": int((time.perf_counter() - t_start) * 1000), "results": results, "actor": actor,
    }, project_id=capability["project_id"])
    db.audit(ORG_ID, actor, "tests.run", resource=f"{capability['id']}@{revision['number']}", project_id=capability["project_id"],
             outcome="success" if run["status"] == "passed" else "failure", details={"passed": passed, "total": len(results)})
    return run
