# APIfication

Governed REST, GraphQL and MCP capabilities from one specification.

Describe a business capability in one sentence, or build it on the visual canvas. APIfication generates a **Canonical Capability Specification** (CCS) and projects it to REST (OpenAPI 3.1), GraphQL, MCP tools, OPA Rego policies, tests and deployable code. Every interface runs through **one** policy and connector path, so a caller denied through REST is denied through GraphQL and MCP too.

The architecture follows `docs/architecture/platform-architecture.md`. This first cut delivers the end-to-end milestone from sections 21, 24 and 31 of that spec.

---

## Quick start

Requirements: **Python 3.10+** and **Node.js 20+** (macOS: `brew install python@3.12 node`).

```bash
./start.sh            # runs ./setup.sh, then starts both services in the background
./stop.sh             # stops them
```

| Script | What it does |
|---|---|
| `./setup.sh` | Finds Python 3.10+, creates `services/control-plane/.venv`, installs backend and frontend dependencies, creates `.env`. Re-runs are fast: it only reinstalls when requirements change. `--prod` also builds the UI; `--force` reinstalls everything. |
| `./start.sh` | Calls `setup.sh`, checks the ports are free, starts the control plane and web UI in the background, waits until both respond, then prints the URLs. `--prod` runs optimised servers; `--skip-setup` skips installation. Ports: `API_PORT` (8000), `WEB_PORT` (3000). |
| `./stop.sh` | Stops both services and their child processes (graceful, then forced after 10 s). `--ports` also frees anything still listening on the two ports. |

Logs go to `.run/logs/api.log` and `.run/logs/web.log`.

- Web UI: http://localhost:3000
- Management API docs: http://localhost:8000/docs

On first start, a demo is seeded automatically. It includes:

- the **Demo CRM** database (SQLite, 60 customers across two tenants);
- the **Customer Service API**, generated from a one-line prompt and deployed to development;
- five API clients: a support agent, a manager, an admin, an MCP client, and a second tenant;
- the **Support Assistant** MCP server, with read-only tools.

Demo client tokens are written to `services/control-plane/.data/dev-tokens.json` (development only). In the UI you never need them: GraphQL Studio, MCP Studio and the Developer Portal call the gateway as a chosen client using a 10-minute exchanged token.

```bash
make test       # 12 end-to-end acceptance tests (spec section 24)
make reset      # wipe local data; the demo re-seeds on next start
docker compose up --build   # control plane + web + PostgreSQL registry
```

## Try the scenario

1. **Overview** shows the three layers (connectors → capabilities → interfaces), traffic and pending approvals.
2. **API Builder**: pick an example prompt and select **Generate**. Review the operations, access matrix, data mapping, assumptions and the agent run, then select **Save capability**.
3. **Capability → Workflow**: edit the typed graph. Data nodes must sit behind an Authorize node's *allowed* port; try removing that edge and select **Validate** to see the `security.unguarded` error.
4. **Run tests** (24 generated tests: role matrix, tenant isolation, redaction, injection…), then **Deploy to development**, then staging. Production creates a release request in **Approvals**.
5. **Developer Portal**: call `GET /customers` as *Support portal (agent.lee)*. It returns only that agent's assigned customers, with email and phone masked and the card number never returned.
6. **MCP Studio**: `initialize`, `tools/list`, `tools/call` as the MCP client. The write tools aren't there.
7. Call `POST /customers/{id}/suspend` as the admin. You get `202 pending_approval`; approve it in **Approvals** and the held request runs.
8. **Monitoring**: each request is traced through authenticate → validate → policy → connector → redact.
9. **Assistant** (top right, or ⌘/): ask “How do I connect an MCP client?”, “Create a project called Payments”, “Run tests”, “Why is my capability invalid?”.

## The in-app assistant

The assistant answers questions about the platform and **acts** through the same services the UI uses. It can:

- create projects and generate capabilities;
- run tests and deploy to development;
- explain validation errors, simulate policies, and navigate.

It knows which page and capability you are looking at.

- **No model configured:** a built-in engine answers from the product guide and the architecture spec, and handles common actions by intent.
- **With a model:** add a provider in **Settings → Model providers** (Anthropic, OpenAI, Azure OpenAI, Ollama or any OpenAI-compatible gateway) and mark it default. The assistant becomes a full tool-calling agent, and the Requirements Analyst and Reviewer agents use it too.

Governance applies to the assistant as well: it cannot approve requests, promote to staging or production, or read secrets. Every assistant action is audited.

## Architecture

```
apps/web                         Next.js 15 + React Flow + Monaco — the product UI
services/control-plane/app
  models.py                      Canonical Capability Specification (Pydantic)
  ir/nodes.py                    Typed node catalogue (plugin contract)
  ir/validator.py                Deterministic validation: graph, policy coverage, secrets, gates
  ir/projections.py              OpenAPI 3.1, GraphQL SDL, MCP tools, OPA Rego
  ir/compiler.py                 Deterministic build artefact (service, contracts, tests, Dockerfile, k8s)
  runtime/executor.py            Synchronous workflow runtime — the single execution path
  runtime/policy.py              Policy decision point: RBAC + ABAC + scopes + row filters, fail-closed
  runtime/gateway.py             Data plane: REST, GraphQL (depth/alias limits), MCP (Streamable HTTP)
  connectors/                    PostgreSQL, SQLite (dev), REST/GraphQL APIs; parameterised SQL only
  ai/generator.py                Prompt → typed plan → deterministic CCS builder
  ai/agents.py                   Supervised agent team with mandatory security/test/review gates
  ai/assistant.py                In-app assistant (tool-calling LLM or built-in engine)
  ai/llm.py                      Model Provider Hub client (Anthropic + OpenAI protocols)
  vault.py                       Secret references; encrypted local vault (swap for Vault/OpenBao)
  testing.py                     Test generation + execution through the real executor
docs/architecture                The reference architecture this implements
```

Key decisions (spec §23/§29) are recorded in `docs/decisions/`.

### Security model in practice
- The browser never connects to databases and never receives credentials; secrets are stored as `secret://vault/...` references.
- Connectors start **read-only**. Granting write access needs a justification, which is written to the audit log.
- Tenant filters come from the caller's identity, never from request parameters. Callers without a tenant cannot read tenant-scoped data.
- Field classification is enforced on every interface. Restricted fields are never selected from the database; confidential fields are masked unless the caller holds the unlock scope.
- The validator rejects data access that isn't guarded by an Authorize node, and the runtime refuses it too (defence in depth).
- Production: no wildcard scopes, GraphQL introspection is off, and every release needs an approved request.

## What's in this first cut, and what's next

| Area | Status |
|---|---|
| CCS, revisions with digests, diff, validator, compiler | ✅ |
| Prompt → spec (deterministic + optional LLM planner), agent team with traces | ✅ |
| Visual workflow canvas with typed ports, palette, inspector, inline validation | ✅ |
| PostgreSQL + SQLite + REST/GraphQL API connectors, discovery, classification, masked preview | ✅ |
| REST, GraphQL and MCP runtimes sharing one policy path | ✅ |
| RBAC/ABAC/scopes/row filters, policy simulator, OPA Rego export, audit, traces | ✅ |
| Generated tests, promotion gates, approvals (releases + held operations) | ✅ |
| Model Provider Hub, in-app assistant | ✅ |
| OIDC/SAML sign-in, SCIM | Next — dev mode signs you in as a local admin |
| Temporal durable workflows, sandboxed custom code | Next |
| MySQL, SQL Server, Oracle, MongoDB, Snowflake, BigQuery connectors | Planned (listed as such in the UI) |
| Signed OCI artefacts, deployment controller to Kubernetes, customer-hosted data plane | Next (generated Dockerfile/k8s manifests are already produced) |
| Postman/Bruno-style request workspace and imports | Next |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `APF_DATABASE_URL` | SQLite in `.data/` | Platform registry (`postgresql+psycopg://…` for Postgres) |
| `APF_DATA_DIR` | `services/control-plane/.data` | Registry, vault, demo DB |
| `APF_SEED_DEMO` | `1` | Seed the demo on first start |
| `APF_EGRESS_ALLOWLIST` | `*` | Hosts that HTTP nodes and model endpoints may call |
| `APF_API_URL` (web) | `http://127.0.0.1:8000` | Where the UI proxies `/api` and `/gw` |
