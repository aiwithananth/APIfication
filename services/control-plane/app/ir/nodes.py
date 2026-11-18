"""Typed node catalogue (node plugin contract, section 26.4).

Each node type declares its category, ports and a configuration schema. The
web canvas renders palette entries and configuration forms from this
catalogue, and the backend validator uses it to type-check graphs. The UI
never invents node types of its own.
"""
from __future__ import annotations

from typing import Any

# field schema: {key, label, type: text|textarea|number|bool|select|tags|json|connector|policy|provider, options?, required?, help?}

NODE_TYPES: dict[str, dict[str, Any]] = {
    # ------------------------------------------------------------------ entry
    "trigger.request": {
        "category": "entry", "label": "Request", "version": "1.0", "icon": "log-in",
        "description": "Entry point for the operation's REST, GraphQL and MCP interfaces.",
        "inputs": [], "outputs": ["out"], "config": [],
    },
    "trigger.webhook": {
        "category": "entry", "label": "Webhook", "version": "1.0", "icon": "webhook",
        "description": "Signed inbound webhook.",
        "inputs": [], "outputs": ["out"],
        "config": [{"key": "signature_header", "label": "Signature header", "type": "text"},
                   {"key": "secret_ref", "label": "Signing secret reference", "type": "text", "help": "secret://vault/..."}],
    },
    "trigger.schedule": {
        "category": "entry", "label": "Schedule", "version": "1.0", "icon": "clock",
        "description": "Cron schedule. Runs on the durable runtime.",
        "inputs": [], "outputs": ["out"],
        "config": [{"key": "cron", "label": "Cron expression", "type": "text", "required": True}],
    },
    # ------------------------------------------------------------------ security
    "security.authorize": {
        "category": "security", "label": "Authorize", "version": "1.0", "icon": "shield-check",
        "description": "Evaluates the operation policy (roles, scopes, attributes). Fails closed.",
        "inputs": ["in"], "outputs": ["allowed", "denied"],
        "config": [{"key": "policy_ref", "label": "Policy", "type": "policy", "required": True},
                   {"key": "required_scopes", "label": "Required scopes", "type": "tags"}],
    },
    "security.approval": {
        "category": "security", "label": "Approval checkpoint", "version": "1.0", "icon": "user-check",
        "description": "Holds the request until an authorised approver decides. Returns 202 with an approval ID.",
        "inputs": ["in"], "outputs": ["approved"],
        "config": [{"key": "approver_role", "label": "Approver role", "type": "text", "required": True},
                   {"key": "reason", "label": "Reason shown to approver", "type": "text"}],
    },
    # ------------------------------------------------------------------ data
    "data.validate": {
        "category": "logic", "label": "Validate input", "version": "1.0", "icon": "list-checks",
        "description": "Validates parameters against the operation's declared schema.",
        "inputs": ["in"], "outputs": ["valid", "invalid"],
        "config": [{"key": "rules", "label": "Extra rules (JSON)", "type": "json",
                    "help": '{"email": {"pattern": "^.+@.+$"}}'}],
    },
    "database.select": {
        "category": "data", "label": "Database select", "version": "1.0", "icon": "database",
        "description": "Parameterised read from a registered connector. Tenant and row policies are applied automatically.",
        "inputs": ["in"], "outputs": ["record", "empty"],
        "config": [{"key": "entity", "label": "Entity", "type": "entity", "required": True},
                   {"key": "mode", "label": "Mode", "type": "select", "options": ["one", "many"], "required": True},
                   {"key": "key_param", "label": "Key parameter (mode=one)", "type": "text"},
                   {"key": "search_param", "label": "Search parameter", "type": "text"},
                   {"key": "search_fields", "label": "Search fields", "type": "tags"},
                   {"key": "limit", "label": "Max rows", "type": "number"}],
    },
    "database.update": {
        "category": "data", "label": "Database update", "version": "1.0", "icon": "database-zap",
        "description": "Updates allow-listed fields of one record. Requires a write-enabled connector.",
        "inputs": ["in"], "outputs": ["record", "empty"],
        "config": [{"key": "entity", "label": "Entity", "type": "entity", "required": True},
                   {"key": "key_param", "label": "Key parameter", "type": "text", "required": True},
                   {"key": "allowed_fields", "label": "Updatable fields", "type": "tags"},
                   {"key": "set_values", "label": "Fixed values (JSON)", "type": "json", "help": '{"status": "suspended"}'}],
    },
    "database.insert": {
        "category": "data", "label": "Database insert", "version": "1.0", "icon": "database-plus",
        "description": "Inserts one record with allow-listed fields.",
        "inputs": ["in"], "outputs": ["record"],
        "config": [{"key": "entity", "label": "Entity", "type": "entity", "required": True},
                   {"key": "allowed_fields", "label": "Insertable fields", "type": "tags", "required": True}],
    },
    "data.redact": {
        "category": "data", "label": "Redact & mask", "version": "1.0", "icon": "eye-off",
        "description": "Removes non-exposed fields and masks classified fields unless the caller holds the unlock scope.",
        "inputs": ["in"], "outputs": ["out"],
        "config": [{"key": "entity", "label": "Entity", "type": "entity", "required": True},
                   {"key": "extra_deny", "label": "Extra denied fields", "type": "tags"}],
    },
    # ------------------------------------------------------------------ logic
    "logic.condition": {
        "category": "logic", "label": "Condition", "version": "1.0", "icon": "split",
        "description": "Routes on a simple comparison of the current payload.",
        "inputs": ["in"], "outputs": ["true", "false"],
        "config": [{"key": "field", "label": "Field", "type": "text", "required": True},
                   {"key": "op", "label": "Operator", "type": "select", "options": ["eq", "neq", "gt", "lt", "exists"]},
                   {"key": "value", "label": "Value", "type": "text"}],
    },
    "transform.map": {
        "category": "logic", "label": "Transform", "version": "1.0", "icon": "shuffle",
        "description": "Renames or selects fields: {\"output_field\": \"input_field\"}.",
        "inputs": ["in"], "outputs": ["out"],
        "config": [{"key": "mapping", "label": "Mapping (JSON)", "type": "json", "required": True}],
    },
    # ------------------------------------------------------------------ integration
    "http.request": {
        "category": "integration", "label": "HTTP request", "version": "1.0", "icon": "globe",
        "description": "Calls an existing REST API. Egress is restricted to the allowlist.",
        "inputs": ["in"], "outputs": ["out", "error"],
        "config": [{"key": "method", "label": "Method", "type": "select", "options": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                   {"key": "url", "label": "URL", "type": "text", "required": True, "help": "Use {param} placeholders"},
                   {"key": "auth_secret_ref", "label": "Bearer token reference", "type": "text"}],
    },
    # ------------------------------------------------------------------ AI
    "ai.model_call": {
        "category": "ai", "label": "Model call", "version": "1.0", "icon": "sparkles",
        "description": "Calls an approved model provider. Restricted data is blocked from unapproved providers.",
        "inputs": ["in"], "outputs": ["out"],
        "config": [{"key": "provider_id", "label": "Provider", "type": "provider", "required": True},
                   {"key": "prompt", "label": "Prompt template", "type": "textarea", "required": True,
                    "help": "Use {{payload}} to include the current data"},
                   {"key": "output_field", "label": "Output field", "type": "text"}],
    },
    # ------------------------------------------------------------------ output
    "output.response": {
        "category": "output", "label": "Response", "version": "1.0", "icon": "send",
        "description": "Returns the payload to the caller (REST response, GraphQL result or MCP tool result).",
        "inputs": ["in"], "outputs": [],
        "config": [{"key": "status", "label": "Status code", "type": "number"}],
    },
    "output.error": {
        "category": "output", "label": "Error", "version": "1.0", "icon": "octagon-x",
        "description": "Returns a typed error.",
        "inputs": ["in"], "outputs": [],
        "config": [{"key": "status", "label": "Status code", "type": "number", "required": True},
                   {"key": "message", "label": "Message", "type": "text"}],
    },
}

CATEGORIES = [
    {"id": "entry", "label": "Entry"},
    {"id": "security", "label": "Security"},
    {"id": "data", "label": "Data"},
    {"id": "logic", "label": "Logic"},
    {"id": "integration", "label": "Integration"},
    {"id": "ai", "label": "AI"},
    {"id": "output", "label": "Output"},
]

WRITE_NODES = {"database.update", "database.insert"}
ENTRY_NODES = {k for k, v in NODE_TYPES.items() if v["category"] == "entry"}
OUTPUT_NODES = {k for k, v in NODE_TYPES.items() if v["category"] == "output"}


def catalogue() -> dict[str, Any]:
    return {"categories": CATEGORIES, "nodes": [{"type": k, **v} for k, v in NODE_TYPES.items()]}
