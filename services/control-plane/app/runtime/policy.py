"""Policy decision point (PDP).

RBAC + ABAC + scopes + relationship (row) checks, evaluated from the policy
definitions in the canonical spec. Protected operations fail closed: a
missing or unverifiable policy is a deny. The same definitions are exported
as OPA Rego (`ir/projections.rego`) for customers who run OPA.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from ..models import PolicySpec


class Principal(BaseModel):
    subject: str
    kind: str = "application"            # application | agent | mcp_client | service | user | synthetic
    roles: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    tenant: Optional[str] = None
    client_id: Optional[str] = None
    client_name: Optional[str] = None
    delegation: list[str] = Field(default_factory=list)  # agent → user chain


class Decision(BaseModel):
    allow: bool
    reason: str
    policy_id: Optional[str] = None
    policy_version: Optional[int] = None
    missing_scopes: list[str] = Field(default_factory=list)
    row_filters: list[dict] = Field(default_factory=list)


def _attr(path: str, ctx: dict[str, Any]) -> Any:
    cur: Any = ctx
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
    return cur


def evaluate(policy: PolicySpec | None, principal: Principal, *, required_scopes: list[str],
             environment: str, request: dict[str, Any] | None = None) -> Decision:
    if policy is None:
        return Decision(allow=False, reason="No policy decision available — failing closed")
    needed = list(dict.fromkeys([*policy.scopes, *required_scopes]))
    missing = [s for s in needed if s not in principal.scopes]
    if missing:
        return Decision(allow=False, reason=f"Missing scope(s): {', '.join(missing)}", policy_id=policy.id,
                        policy_version=policy.version, missing_scopes=missing)
    if policy.roles and not set(policy.roles) & set(principal.roles):
        return Decision(allow=False, reason=f"Requires one of role(s): {', '.join(policy.roles)}",
                        policy_id=policy.id, policy_version=policy.version)
    ctx = {"environment": environment, "principal": principal.model_dump(), "request": request or {}}
    for c in policy.conditions:
        v = _attr(c.attribute, ctx)
        ok = {"eq": v == c.value, "neq": v != c.value,
              "in": v in (c.value or []), "not_in": v not in (c.value or [])}[c.op]
        if not ok:
            return Decision(allow=False, reason=f"Condition failed: {c.attribute} {c.op} {c.value!r}",
                            policy_id=policy.id, policy_version=policy.version)
    filters = []
    for rf in policy.row_filters:
        if rf.when_role and rf.when_role not in principal.roles:
            continue
        val = rf.equals
        if val == "$principal.subject":
            val = principal.subject
        elif val == "$principal.tenant":
            val = principal.tenant
        filters.append({"field": rf.field, "equals": val})
    return Decision(allow=True, reason="Allowed by policy", policy_id=policy.id, policy_version=policy.version,
                    row_filters=filters)
