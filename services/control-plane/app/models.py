"""Typed platform models.

`CapabilitySpec` is the Canonical Capability Specification (CCS): the single
source of truth from which the canvas, REST, GraphQL, MCP, tests, docs and
generated code are all projected.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Classification = Literal["public", "internal", "confidential", "restricted"]
SideEffect = Literal["read", "write", "destructive"]


# --------------------------------------------------------------------------- CCS

class FieldSpec(BaseModel):
    name: str
    type: str = "string"            # string | integer | number | boolean | datetime | json
    classification: Classification = "internal"
    exposed: bool = True            # False = never leaves the platform (denylist)
    masked_unless_scope: Optional[str] = None  # e.g. customer:pii:read
    writable: bool = False
    description: str = ""


class EntitySpec(BaseModel):
    name: str                        # API-facing name, e.g. Customer
    connector_ref: str               # connector id (never credentials)
    resource: str                    # table / collection, e.g. customers
    primary_key: str = "id"
    tenant_key: Optional[str] = None
    owner_key: Optional[str] = None  # relationship check field, e.g. assigned_agent
    fields: list[FieldSpec] = Field(default_factory=list)


class InterfaceSpec(BaseModel):
    kind: Literal["rest", "graphql", "mcp"]
    method: Optional[str] = None          # REST
    path: Optional[str] = None            # REST
    field: Optional[str] = None           # GraphQL field name
    operation: Optional[Literal["query", "mutation"]] = None  # GraphQL
    tool_name: Optional[str] = None       # MCP
    enabled: bool = True


class ParamSpec(BaseModel):
    name: str
    type: str = "string"
    location: Literal["path", "query", "body"] = "query"
    required: bool = False
    description: str = ""
    max_length: Optional[int] = None


class WorkflowNode(BaseModel):
    id: str
    type: str
    label: Optional[str] = None
    config: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(BaseModel):
    id: Optional[str] = None
    source: str
    source_port: str = "out"
    target: str
    target_port: str = "in"


class Workflow(BaseModel):
    runtime_class: Literal["synchronous", "durable", "asynchronous"] = "synchronous"
    nodes: list[WorkflowNode] = Field(default_factory=list)
    edges: list[WorkflowEdge] = Field(default_factory=list)
    layout: dict[str, dict[str, float]] = Field(default_factory=dict)  # UI-only metadata


class OperationSpec(BaseModel):
    id: str
    name: str
    description: str = ""
    entity: Optional[str] = None
    side_effect: SideEffect = "read"
    params: list[ParamSpec] = Field(default_factory=list)
    returns: Literal["one", "many", "none"] = "one"
    required_scopes: list[str] = Field(default_factory=list)
    policy_ref: Optional[str] = None
    approval_required: bool = False
    interfaces: list[InterfaceSpec] = Field(default_factory=list)
    workflow: Workflow = Field(default_factory=Workflow)
    tags: list[str] = Field(default_factory=list)
    timeout_ms: int = 5000
    rate_limit_per_minute: int = 600


class RowFilter(BaseModel):
    when_role: Optional[str] = None        # apply only when principal has this role
    field: str
    equals: str                            # literal or $principal.subject / $principal.tenant


class Condition(BaseModel):
    attribute: str                         # e.g. environment, principal.kind, request.ip
    op: Literal["eq", "neq", "in", "not_in"] = "eq"
    value: Any = None


class PolicySpec(BaseModel):
    id: str
    name: str
    description: str = ""
    roles: list[str] = Field(default_factory=list)          # any-of; empty = any role
    scopes: list[str] = Field(default_factory=list)         # all-of
    conditions: list[Condition] = Field(default_factory=list)
    row_filters: list[RowFilter] = Field(default_factory=list)
    version: int = 1


class ScopeSpec(BaseModel):
    name: str
    description: str = ""


class RoleSpec(BaseModel):
    name: str
    description: str = ""
    scopes: list[str] = Field(default_factory=list)


class TestCase(BaseModel):
    id: str
    name: str
    operation_id: str
    category: Literal["positive", "negative", "role-matrix", "tenant-isolation", "redaction", "injection", "validation"]
    principal: dict[str, Any] = Field(default_factory=dict)  # synthetic principal: roles, scopes, tenant, subject, kind
    input: dict[str, Any] = Field(default_factory=dict)
    expect_status: int = 200
    expect_absent_fields: list[str] = Field(default_factory=list)
    expect_masked_fields: list[str] = Field(default_factory=list)
    expect_max_rows: Optional[int] = None
    interface: Literal["rest", "graphql", "mcp"] = "rest"


class CapabilityMeta(BaseModel):
    id: str
    name: str
    description: str = ""
    domain: str = "general"
    owner: str = ""
    classification: Classification = "internal"
    tags: list[str] = Field(default_factory=list)
    base_path: str = "/"


class CapabilitySpec(BaseModel):
    ccs_version: str = "1.0"
    capability: CapabilityMeta
    entities: list[EntitySpec] = Field(default_factory=list)
    operations: list[OperationSpec] = Field(default_factory=list)
    policies: list[PolicySpec] = Field(default_factory=list)
    scopes: list[ScopeSpec] = Field(default_factory=list)
    roles: list[RoleSpec] = Field(default_factory=list)
    tests: list[TestCase] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- management entities

class ProjectIn(BaseModel):
    name: str
    description: str = ""
    slug: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    owner: str = ""


class ConnectorIn(BaseModel):
    name: str
    type: Literal["postgresql", "sqlite", "mysql", "sqlserver", "oracle", "mongodb", "snowflake", "bigquery", "rest_api", "graphql_api"]
    hosting: Literal["customer_cloud", "private_network", "public_endpoint", "local_development"] = "local_development"
    host: str = ""
    port: Optional[int] = None
    database: str = ""
    username: str = ""
    password: Optional[str] = None       # write-only: goes straight to the vault
    auth_method: Literal["password", "tls_cert", "mtls", "cloud_iam", "managed_identity", "none"] = "password"
    tls_mode: Literal["verify-full", "verify-ca", "require", "disable"] = "verify-full"
    base_url: str = ""                   # rest_api / graphql_api
    environment: Literal["development", "staging", "production"] = "development"
    tags: list[str] = Field(default_factory=list)
    owner: str = ""
    classification: Classification = "internal"
    project_ids: list[str] = Field(default_factory=list)
    read_only: bool = True
    options: dict[str, Any] = Field(default_factory=dict)


class ProviderIn(BaseModel):
    name: str
    provider_type: Literal["openai", "anthropic", "azure_openai", "ollama", "openai_compatible", "builtin"]
    base_url: str = ""
    model: str = ""
    api_key: Optional[str] = None        # write-only
    region: str = ""
    data_classification_max: Classification = "internal"
    timeout_s: int = 60
    max_tokens: int = 2048
    capabilities: list[str] = Field(default_factory=list)
    enabled_projects: list[str] = Field(default_factory=list)
    headers: dict[str, str] = Field(default_factory=dict)
    is_default: bool = False


class AgentIn(BaseModel):
    name: str
    role: str
    purpose: str = ""
    system_prompt: str = ""
    provider_id: Optional[str] = None
    temperature: float = 0.2
    tools: list[str] = Field(default_factory=list)
    max_turns: int = 6
    token_budget: int = 16000
    enabled: bool = True
    approval_required: bool = False
    mandatory: bool = False
    order: int = 100


class ApiClientIn(BaseModel):
    name: str
    kind: Literal["application", "agent", "mcp_client", "service"] = "application"
    subject: str = ""
    roles: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    tenant: Optional[str] = None
    environments: list[str] = Field(default_factory=lambda: ["development"])
    project_ids: list[str] = Field(default_factory=list)


class McpServerIn(BaseModel):
    name: str
    project_id: str
    description: str = ""
    tool_operation_ids: list[str] = Field(default_factory=list)   # "<capability_id>:<operation_id>"
    allowed_client_ids: list[str] = Field(default_factory=list)
    discoverable: bool = False


class TagIn(BaseModel):
    key: str
    value: str
    description: str = ""
    security_sensitive: bool = False


class GenerateRequest(BaseModel):
    prompt: str
    project_id: str
    connector_id: Optional[str] = None
    use_agents: bool = True


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: dict[str, Any] = Field(default_factory=dict)  # page, project_id, capability_id, selection
