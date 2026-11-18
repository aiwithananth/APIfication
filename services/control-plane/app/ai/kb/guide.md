# APIfication product guide

## What APIfication does
APIfication turns a business requirement into a governed capability. You describe the capability once, in plain language or on the visual canvas. The platform then generates a canonical specification, a workflow, REST, GraphQL and MCP interfaces, policies, scopes and tests. REST, GraphQL and MCP are projections of one specification and share one policy path, so a caller denied through REST is also denied through GraphQL and MCP.

## Getting started
1. Open Connectors and register a database (or use the seeded Demo CRM connector).
2. Open API Builder, pick a project and connector, and describe the API in one sentence.
3. Review the generated plan, assumptions, roles, scopes and data mapping, then select Save capability.
4. Open the capability to edit the workflow on the canvas, inspect the OpenAPI, GraphQL and MCP projections, and run tests.
5. Deploy to development. Promote to staging once tests pass, and to production after approval.
6. Issue an API client in Security to call the published endpoints, and create an MCP server in MCP Studio to expose read-only tools to AI agents.

## Projects
A project owns related capabilities, connectors, MCP servers, policies and deployments. Every project has a slug used in gateway URLs, for example /gw/development/customer-service/api/customers.

## API Builder
The API Builder turns one prompt into a complete draft. Mention the entity (table), the operations (search, detail, update, create, suspend), the roles and what they may do, sensitive data that must not be exposed, and which interfaces you want (REST, GraphQL, MCP). Example: "Create a customer service API using the Demo CRM database. Support agents can read assigned customers, managers can update profile fields, administrators can suspend accounts with approval. Do not expose payment-card data. Create an MCP server with read-only tools."
The builder asks a question only when something is genuinely blocking, such as a missing status column. Otherwise it records assumptions you can review. When a model provider is configured, the Requirements Analyst agent uses it to extract the plan; the deterministic builder and validator always produce the final specification.

## Workflow Studio (canvas)
Each operation has a typed workflow graph. Drag nodes from the palette, connect output ports to input ports, and select a node to edit its configuration. Data nodes must be reached only through the allowed port of an Authorize node; the validator rejects any path that bypasses authorization. Select Validate to check the graph and Save revision to store a new immutable revision. Node categories: Entry, Security, Data, Logic, Integration, AI and Output.

## Canonical specification and revisions
Every save creates an immutable revision with a SHA-256 digest. A revision is "validated" when the deterministic validator finds no errors, and "released" once deployed. Deployments always point at an immutable revision. Use the Revisions tab to compare revisions.

## Validation errors
Common errors and fixes:
- security.unguarded: a data node can be reached without passing an Authorize node. Connect the Authorize node's allowed port before the data node.
- policy.missing / policy.unknown: every operation needs an explicit policy. Pick a policy in the Authorize node or the operation settings.
- scope.undeclared: a scope is used but not declared. Add it in the Policies tab.
- connector.read_only: write nodes need a write-enabled connector. Enable write access on the connector (this is recorded in the audit log).
- approval.destructive: destructive operations must require approval.
- secret.inline: a value looks like a password or key. Store it in the vault and use a secret reference.
- graph.no_output: the workflow never reaches a Response node.

## Connectors (Database & Connector Centre)
Register PostgreSQL databases (production-grade), SQLite files (local development only) and existing REST/GraphQL APIs. Other connectors (MySQL, SQL Server, Oracle, MongoDB, Snowflake, BigQuery) are listed as planned and are not production-supported yet. Credentials go straight to the vault; the registry stores only a secret reference and the browser never receives them. New connectors are read-only until write access is explicitly enabled. After testing the connection, discover the schema and classify columns: mark fields as public, internal, confidential or restricted, hide fields, or mask them unless the caller holds a scope such as customer:pii:read.

## Security & Policies
Roles describe who a caller is acting as. Scopes are narrow, action-oriented permissions carried by tokens, for example customer:read or customer:profile:update. Tags are governance labels, not permissions. Policies combine roles, scopes, attribute conditions and row filters (for example, support agents only see customers assigned to them). The policy engine fails closed: a missing policy is a deny. Policies are also exported as OPA Rego.
API clients are the identities that call published APIs and MCP servers. Each has roles, scopes, an optional tenant, and allowed environments. Tokens are shown once and stored only as hashes. Use the Policy simulator to check whether a given role and scope set would be allowed.

## Tenant isolation
If an entity has a tenant column (tenant_id), every query is filtered by the caller's tenant from their trusted identity. Tenant IDs in request parameters are ignored. A caller without a tenant cannot read tenant-scoped data.

## GraphQL Studio
Shows the GraphQL schema generated from deployed capabilities for a project and environment, with a query console. Query depth is limited to 6 and aliases to 15. Introspection is disabled in production.

## MCP Studio
Create an MCP server for a project, pick the deployed operations that become tools, and restrict which API clients may use it. Tools are read-only by default. Connect any MCP client to the server URL /gw/{environment}/mcp/{server-slug} with a Bearer token from an API client. The server implements initialize, tools/list and tools/call over Streamable HTTP with JSON responses. The built-in test client lets you list and call tools as a chosen API client.

## Agentic Workspace
A supervised team of specialist agents (Supervisor, Requirements Analyst, Database Architect, API Architect, GraphQL Architect, Workflow Engineer, Security Architect, MCP Engineer, Test Architect, Reviewer, Release Agent) produces each capability. Configure each agent's model provider, temperature, prompt and tools. Security Architect, Test Architect and Reviewer are mandatory and cannot be disabled. Every run is recorded with per-agent steps, timings and findings.

## Model providers (Settings)
Register OpenAI, Anthropic, Azure OpenAI, Ollama or any OpenAI-compatible endpoint. Enter a base URL, a model ID and an API key; the key is stored in the vault and never shown again. Test the provider to record which capabilities it supports (text, tool calling, structured output). Mark one provider as default to power this assistant and the agents. Without a provider, the platform uses its built-in deterministic engine.

## Testing & Validation
Tests are generated from the specification: positive, negative (missing scope), role matrix, tenant isolation, redaction (restricted fields never returned, confidential fields masked), SQL injection and input validation. Tests run through the same executor as the gateway. A revision must pass its tests before it can be promoted to staging.

## Deployments & Environments
Environments are development, staging and production. Gates: development requires a validated revision; staging requires a passing test run for that revision; production requires an approved release request. Rollback by deploying an earlier revision.

## Approvals
Operations marked "approval required" (for example suspending an account) return 202 with an approval ID. An approver reviews the held request in Approvals and approves or rejects it; on approval the platform executes the original request with the original caller's identity. Production releases also go through Approvals.

## Monitoring & Audit
Every gateway request produces a trace showing authentication, policy decision, each workflow node, the connector call and redaction. Audit events record who changed what, policy decisions, approvals and deployments.

## Developer portal
For every deployed capability: base URLs, OpenAPI document, required scopes, example requests (curl), GraphQL examples and MCP connection instructions.

## Calling a published API
curl -H "Authorization: Bearer <token>" http://localhost:8000/gw/development/customer-service/api/customers?q=smith
GraphQL: POST /gw/development/customer-service/graphql with {"query": "{ searchCustomers(q: \"smith\") { id first_name } }"}
MCP: POST /gw/development/mcp/support-assistant with a JSON-RPC body such as {"jsonrpc":"2.0","id":1,"method":"tools/list"}

## The assistant
The assistant (this chat) answers questions about the platform and can act for you: create projects, generate capabilities from a description, run tests, deploy to development, explain validation errors, simulate policies and navigate. It cannot approve releases or deploy to staging or production; those stay with people.
