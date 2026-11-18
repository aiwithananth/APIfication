"""End-to-end acceptance scenario (architecture spec, section 24) against the seeded demo."""
import json
import os
import shutil
import tempfile

import pytest

_tmp = tempfile.mkdtemp(prefix="apf-test-")
os.environ["APF_DATA_DIR"] = _tmp
os.environ["APF_DEMO_DB"] = os.path.join(_tmp, "demo.sqlite")

from fastapi.testclient import TestClient  # noqa: E402

from app.config import DATA_DIR  # noqa: E402
from app.main import app  # noqa: E402

BASE = "/gw/development/customer-service"


@pytest.fixture(scope="module")
def c():
    with TestClient(app) as client:
        yield client
    shutil.rmtree(_tmp, ignore_errors=True)


@pytest.fixture(scope="module")
def tok(c):
    return json.loads((DATA_DIR / "dev-tokens.json").read_text())


def H(tok, name):
    return {"Authorization": f"Bearer {tok[name]}"}


def test_generated_capability_is_valid_and_deployed(c):
    caps = c.get("/v1/capabilities").json()
    assert caps and caps[0]["environments"] == ["development"]
    rev = c.get(f"/v1/capabilities/{caps[0]['id']}").json()["revision"]
    assert rev["validation"]["valid"], rev["validation"]
    fields = {f["name"]: f for f in rev["spec"]["entities"][0]["fields"]}
    assert fields["card_number"]["exposed"] is False


def test_generated_tests_pass(c):
    cid = c.get("/v1/capabilities").json()[0]["id"]
    run = c.post(f"/v1/capabilities/{cid}/tests/run").json()
    assert run["status"] == "passed", [r for r in run["results"] if not r["passed"]]


def test_rest_row_and_tenant_isolation(c, tok):
    rows = c.get(f"{BASE}/api/customers?limit=50", headers=H(tok, "Support portal (agent.lee)")).json()
    assert rows and {r["assigned_agent"] for r in rows} == {"agent.lee"}
    assert {r["tenant_id"] for r in rows} == {"tenant-acme"}
    assert all("card_number" not in r and "•" in r["email"] for r in rows)
    globex = c.get(f"{BASE}/api/customers?limit=50", headers=H(tok, "Globex partner app")).json()
    assert {r["tenant_id"] for r in globex} == {"tenant-globex"}


def test_unauthenticated_and_forbidden(c, tok):
    assert c.get(f"{BASE}/api/customers").status_code == 401
    r = c.patch(f"{BASE}/api/customers/CUS-1003", headers=H(tok, "Support portal (agent.lee)"), json={"city": "X"})
    assert r.status_code == 403 and "scope" in r.json()["reason"].lower()


def test_manager_update_and_pii(c, tok):
    r = c.patch(f"{BASE}/api/customers/CUS-1003", headers=H(tok, "Manager console"), json={"city": "Perth"})
    assert r.status_code == 200 and r.json()["city"] == "Perth" and "@" in r.json()["email"] and "•" not in r.json()["email"]
    assert c.patch(f"{BASE}/api/customers/CUS-1003", headers=H(tok, "Manager console"), json={"tenant_id": "x"}).status_code == 422


def test_suspend_requires_approval_then_runs(c, tok):
    r = c.post(f"{BASE}/api/customers/CUS-1005/suspend", headers=H(tok, "Admin console"), json={"reason": "review"})
    assert r.status_code == 202
    d = c.post(f"/v1/approvals/{r.json()['approval_id']}/decision", json={"decision": "approve"}).json()
    assert d["result"]["status"] == 200 and d["result"]["body"]["status"] == "suspended"


def test_graphql_same_policy(c, tok):
    q = {"query": 'mutation { updateCustomerProfile(customer_id: "CUS-1003", city: "X") { id } }'}
    r = c.post(f"{BASE}/graphql", headers=H(tok, "Support portal (agent.lee)"), json=q).json()
    assert r["errors"][0]["extensions"]["code"] == "FORBIDDEN"
    deep = "{ searchCustomers { id } }"
    assert "data" in c.post(f"{BASE}/graphql", headers=H(tok, "Manager console"), json={"query": deep}).json()


def test_mcp_read_only_tools(c, tok):
    m = "/gw/development/mcp/support-assistant"
    h = H(tok, "Support assistant (MCP)")
    init = c.post(m, headers=h, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
    assert init.json()["result"]["protocolVersion"] == "2025-06-18"
    tools = [t["name"] for t in c.post(m, headers=h, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).json()["result"]["tools"]]
    assert sorted(tools) == ["get_customer", "search_customers"]
    ok = c.post(m, headers=h, json={"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                                    "params": {"name": "search_customers", "arguments": {"q": "a", "limit": 2}}}).json()
    assert ok["result"]["isError"] is False
    call = c.post(m, headers=h, json={"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                      "params": {"name": "update_customer_profile", "arguments": {}}}).json()
    assert "error" in call
    assert c.post(m, headers=H(tok, "Manager console"), json={"jsonrpc": "2.0", "id": 4, "method": "tools/list"}).status_code == 403


def test_promotion_gates(c):
    cid = c.get("/v1/capabilities").json()[0]["id"]
    c.post(f"/v1/capabilities/{cid}/tests/run")
    assert c.post("/v1/deployments", json={"capability_id": cid, "environment": "staging"}).status_code == 200
    r = c.post("/v1/deployments", json={"capability_id": cid, "environment": "production"}).json()
    assert r["status"] == "pending_approval"


def test_audit_and_traces(c):
    assert any(e["action"] == "policy.decision" for e in c.get("/v1/audit-events").json())
    assert {t["interface"] for t in c.get("/v1/traces").json()} >= {"rest", "graphql", "mcp"}


def test_validator_rejects_unguarded_data_access(c):
    cid = c.get("/v1/capabilities").json()[0]["id"]
    spec = c.get(f"/v1/capabilities/{cid}").json()["revision"]["spec"]
    op = spec["operations"][0]
    op["workflow"]["edges"] = [e for e in op["workflow"]["edges"] if e["target"] != "authorize"] + [
        {"source": "validate", "source_port": "valid", "target": "load", "target_port": "in"}]
    v = c.post("/v1/validate", json={"spec": spec}).json()
    assert not v["valid"] and any(e["code"] == "security.unguarded" for e in v["errors"])


def test_assistant_offline(c):
    r = c.post("/v1/assistant/chat", json={"messages": [{"role": "user", "content": "How do I connect an MCP client?"}], "context": {"page": "/"}}).json()
    assert "MCP" in r["reply"]
