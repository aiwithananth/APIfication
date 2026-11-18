"""Demo seed: a working end-to-end scenario on first start (section 24).

Creates a demo CRM database, registers it as a connector with classified
columns, generates the "Customer Service API" from a one-line prompt,
deploys it to development, issues API clients and publishes an MCP server.
"""
from __future__ import annotations

import json
import random
import sqlite3

from . import db
from .config import DATA_DIR, DEMO_DB_PATH, ORG_ID
from .connectors import get_connector

DEMO_PROMPT = ("Create a customer service API using the registered Demo CRM database. Generate REST and GraphQL "
               "interfaces for customer search, customer detail retrieval and profile updates. Support agents can read "
               "assigned customers, managers can update permitted profile fields, and administrators can suspend accounts "
               "with approval. Do not expose payment-card data. Create an MCP server with read-only tools for the "
               "support assistant. Deploy to development first.")

FIRST = ["Ava", "Noah", "Mia", "Liam", "Zara", "Ethan", "Isla", "Arjun", "Chloe", "Kenji", "Priya", "Lucas", "Aisha", "Oliver",
         "Sofia", "Mateo", "Hana", "Leo", "Grace", "Ravi"]
LAST = ["Smith", "Nguyen", "Patel", "Garcia", "Kim", "Brown", "Martin", "Rossi", "Okafor", "Silva", "Chen", "Walker", "Iyer",
        "Novak", "Haddad", "Larsen"]
CITIES = [("Sydney", "AU"), ("Melbourne", "AU"), ("Auckland", "NZ"), ("Singapore", "SG"), ("London", "GB"), ("Toronto", "CA")]


def create_demo_db() -> None:
    if DEMO_DB_PATH.exists():
        return
    rnd = random.Random(42)
    con = sqlite3.connect(DEMO_DB_PATH)
    con.executescript("""
    CREATE TABLE customers (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
      city TEXT, country TEXT, tier TEXT, status TEXT, assigned_agent TEXT, card_number TEXT, risk_score REAL,
      created_at TEXT);
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT REFERENCES customers(id), total REAL,
      currency TEXT, status TEXT, placed_at TEXT);
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT REFERENCES customers(id), subject TEXT,
      priority TEXT, status TEXT, assigned_agent TEXT, internal_note TEXT, opened_at TEXT);
    """)
    agents = ["agent.lee", "agent.rao", "agent.diaz"]
    for i in range(1, 61):
        tenant = "tenant-acme" if i <= 40 else "tenant-globex"
        f, l = rnd.choice(FIRST), rnd.choice(LAST)
        city, cc = rnd.choice(CITIES)
        con.execute("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            f"CUS-{1000 + i}", tenant, f, l, f"{f.lower()}.{l.lower()}{i}@example.com", f"+61 4{rnd.randint(10, 99)} {rnd.randint(100, 999)} {rnd.randint(100, 999)}",
            city, cc, rnd.choice(["standard", "gold", "platinum"]), "active", agents[i % 3],
            f"4{rnd.randint(100, 999)}{rnd.randint(1000, 9999)}{rnd.randint(1000, 9999)}{rnd.randint(1000, 9999)}",
            round(rnd.random(), 3), f"2025-{rnd.randint(1, 12):02d}-{rnd.randint(1, 28):02d}T09:00:00Z"))
        for j in range(rnd.randint(0, 3)):
            con.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?)", (f"ORD-{i}{j}", tenant, f"CUS-{1000 + i}",
                        round(rnd.uniform(20, 900), 2), "AUD", rnd.choice(["paid", "shipped", "refunded"]), "2026-03-01T10:00:00Z"))
        if rnd.random() < 0.4:
            con.execute("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?,?,?)", (f"TCK-{i}", tenant, f"CUS-{1000 + i}",
                        rnd.choice(["Card declined", "Delivery delayed", "Change address", "Refund request"]),
                        rnd.choice(["low", "medium", "high"]), "open", agents[i % 3], "Customer called twice", "2026-04-02T08:00:00Z"))
    con.commit()
    con.close()


def seed() -> None:
    if db.list_records("project", ORG_ID):
        return
    from .ai import assistant  # noqa: F401
    from .routers.ai import default_agent_records
    from .routers.core import create_project, generate_capability
    from .routers.governance import deploy
    from .services import issue_token

    create_demo_db()
    db.put_record("model_provider", ORG_ID, {"name": "Built-in engine", "provider_type": "builtin", "model": "",
                                             "status": "active", "is_default": False, "health": "healthy",
                                             "tested_capabilities": ["text"], "data_classification_max": "restricted",
                                             "base_url": "", "capabilities": ["text"]}, id="prov_builtin")
    for a in default_agent_records():
        db.put_record("agent", ORG_ID, a, id=f"agt_{a['key']}")
    for k, v, d, s in [("domain", "customer", "Customer domain", False),
                       ("data-classification", "confidential", "Confidential data", True),
                       ("data-classification", "restricted", "Restricted data", True),
                       ("exposure", "mcp-approved", "Approved for MCP exposure", True),
                       ("approval", "required", "Requires approval", True),
                       ("operation", "read-only", "Read-only operation", False)]:
        db.put_record("tag", ORG_ID, {"key": k, "value": v, "name": f"{k}:{v}", "description": d, "security_sensitive": s},
                      id=db.new_id("tag"))

    project = create_project("Customer Service", "Customer support capabilities for agents, managers and AI assistants.",
                             ["domain:customer"])
    conn = db.put_record("connector", ORG_ID, {
        "name": "Demo CRM", "type": "sqlite", "hosting": "local_development", "database": str(DEMO_DB_PATH),
        "environment": "development", "auth_method": "none", "tls_mode": "disable", "read_only": True, "status": "active",
        "health": "untested", "tags": ["domain:customer", "environment:development"], "owner": "Customer Platform",
        "classification": "confidential", "project_ids": [project["id"]], "field_policies": {}, "options": {}},
        id="conn_demo_crm")
    c = get_connector(conn)
    conn["last_test"] = c.test()
    conn["health"] = "healthy" if conn["last_test"]["ok"] else "failing"
    schema = c.discover()
    from .connectors import suggest_classification
    fp = {}
    for t in schema["schemas"][0]["tables"]:
        for col in t["columns"]:
            s = suggest_classification(col["name"])
            col["suggestion"] = s
            fp[f"{t['name']}.{col['name']}"] = {"classification": s["classification"], "exposed": s["exposed"], "source": "suggested"}
    fp["customers.card_number"] = {"classification": "restricted", "exposed": False, "source": "admin",
                                   "description": "Payment card number — blocked"}
    conn["schema"] = schema
    conn["field_policies"] = fp
    # managers update profiles → write access approved for the demo connector (recorded in audit)
    conn["read_only"] = False
    db.put_record("connector", ORG_ID, conn)
    db.audit(ORG_ID, "seed", "connector.write_access.grant", resource=conn["id"], details={"reason": "Demo: profile updates approved"})

    r = generate_capability(DEMO_PROMPT, project["id"], conn["id"])
    cap = r["capability"]
    deploy(cap["id"], "development", actor="seed")

    clients = [
        ("Support portal (agent.lee)", "application", "agent.lee", ["support_agent"], ["customer:search", "customer:read"], "tenant-acme"),
        ("Manager console", "application", "manager.kim", ["manager"],
         ["customer:search", "customer:read", "customer:profile:update", "customer:pii:read"], "tenant-acme"),
        ("Admin console", "application", "admin.root", ["admin"],
         ["customer:search", "customer:read", "customer:status:update"], "tenant-acme"),
        ("Support assistant (MCP)", "mcp_client", "agent.lee", ["support_agent"], ["customer:search", "customer:read"], "tenant-acme"),
        ("Globex partner app", "application", "agent.rao", ["support_agent"], ["customer:search", "customer:read"], "tenant-globex"),
    ]
    tokens = {}
    ids = {}
    for name, kind, subject, roles, scopes, tenant in clients:
        rec, tok = issue_token({"name": name, "kind": kind, "subject": subject, "roles": roles, "scopes": scopes,
                                "tenant": tenant, "environments": ["development", "staging"], "project_ids": [project["id"]],
                                "status": "active"})
        saved = db.put_record("api_client", ORG_ID, rec, id=db.new_id("cli"))
        tokens[name] = tok
        ids[name] = saved["id"]
    (DATA_DIR / "dev-tokens.json").write_text(json.dumps(tokens, indent=2))

    spec = r["spec"]
    tool_ops = [f"{cap['id']}:{o['id']}" for o in spec["operations"] if any(i["kind"] == "mcp" for i in o["interfaces"])]
    db.put_record("mcp_server", ORG_ID, {"name": "Support Assistant", "slug": "support-assistant", "project_id": project["id"],
                                         "description": "Read-only customer tools for the support assistant.",
                                         "tool_operation_ids": tool_ops,
                                         "allowed_client_ids": [ids["Support assistant (MCP)"], ids["Support portal (agent.lee)"]],
                                         "discoverable": False, "version": 1}, id=db.new_id("mcp"), project_id=project["id"])
    db.audit(ORG_ID, "seed", "platform.seed", details={"project": project["slug"]})
