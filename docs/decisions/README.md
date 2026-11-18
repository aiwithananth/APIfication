# Architecture decision records

Decisions locked for the first implementation (architecture spec §23 and §29). Each entry is a short ADR; split into separate files as they evolve.

| # | Decision | Status | Where it lives |
|---|---|---|---|
| 1 | React Flow is the canvas; canvas state is **not** the source of truth. The canvas adapter maps to the IR and only layout metadata is persisted with it. | Accepted | `apps/web/components/WorkflowCanvas.tsx` |
| 2 | The Canonical Capability Specification (versioned JSON IR) is the source of truth, independent of any UI library. Revisions are immutable and digested. | Accepted | `app/models.py`, `app/db.py` (revisions) |
| 3 | Synchronous requests run on a low-latency executor; Temporal is reserved for durable workflows (not yet integrated). | Accepted | `app/runtime/executor.py` |
| 4 | AI agents coordinate design but cannot grant permissions. Mandatory security/test/review stages cannot be disabled; the deterministic validator decides. | Accepted | `app/ai/agents.py`, `app/ir/validator.py` |
| 5 | Generated code is a deterministic build artefact; the spec, policies and tests remain authoritative. | Accepted | `app/ir/compiler.py` |
| 6 | REST, GraphQL and MCP call the same executor and policy decision point. | Accepted | `app/runtime/gateway.py` |
| 7 | Database access goes through server-side connectors with least-privilege, read-only-by-default access and parameterised SQL. | Accepted | `app/connectors/` |
| 8 | SaaS and self-hosted share the same control-plane/data-plane contracts; in development both run in one process. | Accepted | `app/main.py` |
| 9 | Production deployment is a separate, approved action promoting an immutable revision. | Accepted | `app/routers/governance.py` (`deploy`) |
| 10 | Node types are versioned plugins declared in a catalogue; the UI renders forms from it. Third-party plugins will run in isolated workers. | Accepted (catalogue); sandboxing next | `app/ir/nodes.py` |
| 11 | The LLM proposes a small typed *plan*; a deterministic builder produces the full spec. This keeps output valid with or without a model. | Accepted | `app/ai/generator.py` |
| 12 | The in-app assistant uses the same service functions as the UI and inherits governance (no approvals, no staging/production promotion). | Accepted | `app/ai/assistant.py` |
