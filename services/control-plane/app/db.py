"""Platform registry storage.

The registry keeps typed records (validated with Pydantic in `models.py`) in
a small number of tables so it runs identically on SQLite and PostgreSQL:

* records        – current state of every governed entity
* revisions      – immutable Canonical Capability Specification revisions
* audit_events   – append-only security and lifecycle events
* traces         – request traces across gateway → policy → workflow → connector
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import (JSON, Column, DateTime, Integer, MetaData, String, Table, Text, create_engine, delete,
                        insert, select, update)
from sqlalchemy.engine import Engine

from .config import DATABASE_URL

metadata = MetaData()

records = Table(
    "records", metadata,
    Column("id", String(64), primary_key=True),
    Column("kind", String(48), index=True, nullable=False),
    Column("org_id", String(64), index=True, nullable=False),
    Column("project_id", String(64), index=True, nullable=True),
    Column("name", String(255), nullable=True),
    Column("data", JSON, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

revisions = Table(
    "revisions", metadata,
    Column("id", String(64), primary_key=True),
    Column("capability_id", String(64), index=True, nullable=False),
    Column("number", Integer, nullable=False),
    Column("status", String(24), nullable=False),  # draft | validated | released
    Column("parent_id", String(64), nullable=True),
    Column("summary", Text, nullable=True),
    Column("author", String(128), nullable=True),
    Column("digest", String(80), nullable=False),
    Column("spec", JSON, nullable=False),
    Column("validation", JSON, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

audit_events = Table(
    "audit_events", metadata,
    Column("id", String(64), primary_key=True),
    Column("org_id", String(64), index=True, nullable=False),
    Column("project_id", String(64), index=True, nullable=True),
    Column("actor", String(128), nullable=False),
    Column("actor_type", String(32), nullable=False),
    Column("action", String(96), index=True, nullable=False),
    Column("resource", String(255), nullable=True),
    Column("outcome", String(24), nullable=False),
    Column("details", JSON, nullable=True),
    Column("created_at", DateTime(timezone=True), index=True, nullable=False),
)

traces = Table(
    "traces", metadata,
    Column("id", String(64), primary_key=True),
    Column("org_id", String(64), index=True, nullable=False),
    Column("project_id", String(64), index=True, nullable=True),
    Column("interface", String(16), nullable=False),
    Column("environment", String(24), nullable=False),
    Column("operation", String(128), nullable=True),
    Column("client", String(128), nullable=True),
    Column("status", Integer, nullable=False),
    Column("duration_ms", Integer, nullable=False),
    Column("spans", JSON, nullable=False),
    Column("created_at", DateTime(timezone=True), index=True, nullable=False),
)

_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        kwargs: dict[str, Any] = {"future": True}
        if DATABASE_URL.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        _engine = create_engine(DATABASE_URL, **kwargs)
        metadata.create_all(_engine)
    return _engine


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _row(r) -> dict[str, Any]:
    d = dict(r._mapping)
    for k, v in list(d.items()):
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


# --------------------------------------------------------------------------- records

def put_record(kind: str, org_id: str, data: dict[str, Any], *, id: str | None = None,
               project_id: str | None = None) -> dict[str, Any]:
    rid = id or data.get("id") or new_id(kind[:4])
    data = {**data, "id": rid}
    ts = now()
    with engine().begin() as c:
        existing = c.execute(select(records.c.id, records.c.created_at).where(records.c.id == rid)).first()
        if existing:
            c.execute(update(records).where(records.c.id == rid).values(
                data=data, name=data.get("name"), project_id=project_id or data.get("project_id"), updated_at=ts))
            created = existing.created_at
        else:
            c.execute(insert(records).values(id=rid, kind=kind, org_id=org_id, project_id=project_id or data.get("project_id"),
                                             name=data.get("name"), data=data, created_at=ts, updated_at=ts))
            created = ts
    return {**data, "created_at": _iso(created), "updated_at": ts.isoformat()}


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def get_record(kind: str, rid: str) -> dict[str, Any] | None:
    with engine().connect() as c:
        r = c.execute(select(records).where(records.c.id == rid, records.c.kind == kind)).first()
    if not r:
        return None
    return {**r.data, "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at)}


def list_records(kind: str, org_id: str, project_id: str | None = None) -> list[dict[str, Any]]:
    q = select(records).where(records.c.kind == kind, records.c.org_id == org_id)
    if project_id:
        q = q.where(records.c.project_id == project_id)
    q = q.order_by(records.c.created_at)
    with engine().connect() as c:
        rows = c.execute(q).all()
    return [{**r.data, "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at)} for r in rows]


def delete_record(kind: str, rid: str) -> bool:
    with engine().begin() as c:
        res = c.execute(delete(records).where(records.c.id == rid, records.c.kind == kind))
    return res.rowcount > 0


# --------------------------------------------------------------------------- revisions

def add_revision(capability_id: str, spec: dict[str, Any], *, status: str, digest: str, author: str,
                 summary: str | None, validation: dict | None, parent_id: str | None) -> dict[str, Any]:
    with engine().begin() as c:
        last = c.execute(select(revisions.c.number).where(revisions.c.capability_id == capability_id)
                         .order_by(revisions.c.number.desc())).first()
        number = (last.number + 1) if last else 1
        rid = new_id("rev")
        c.execute(insert(revisions).values(id=rid, capability_id=capability_id, number=number, status=status,
                                           parent_id=parent_id, summary=summary, author=author, digest=digest,
                                           spec=spec, validation=validation, created_at=now()))
    return get_revision(rid)  # type: ignore[return-value]


def get_revision(rid: str) -> dict[str, Any] | None:
    with engine().connect() as c:
        r = c.execute(select(revisions).where(revisions.c.id == rid)).first()
    return _row(r) if r else None


def list_revisions(capability_id: str) -> list[dict[str, Any]]:
    with engine().connect() as c:
        rows = c.execute(select(revisions).where(revisions.c.capability_id == capability_id)
                         .order_by(revisions.c.number.desc())).all()
    return [_row(r) for r in rows]


def set_revision_status(rid: str, status: str) -> None:
    with engine().begin() as c:
        c.execute(update(revisions).where(revisions.c.id == rid).values(status=status))


# --------------------------------------------------------------------------- audit + traces

def audit(org_id: str, actor: str, action: str, *, resource: str | None = None, outcome: str = "success",
          actor_type: str = "user", project_id: str | None = None, details: dict | None = None) -> None:
    with engine().begin() as c:
        c.execute(insert(audit_events).values(id=new_id("evt"), org_id=org_id, project_id=project_id, actor=actor,
                                              actor_type=actor_type, action=action, resource=resource, outcome=outcome,
                                              details=details or {}, created_at=now()))


def list_audit(org_id: str, limit: int = 200, project_id: str | None = None, action: str | None = None) -> list[dict]:
    q = select(audit_events).where(audit_events.c.org_id == org_id)
    if project_id:
        q = q.where(audit_events.c.project_id == project_id)
    if action:
        q = q.where(audit_events.c.action.like(f"{action}%"))
    q = q.order_by(audit_events.c.created_at.desc()).limit(limit)
    with engine().connect() as c:
        return [_row(r) for r in c.execute(q).all()]


def add_trace(org_id: str, project_id: str | None, interface: str, environment: str, operation: str | None,
              client: str | None, status: int, duration_ms: int, spans: list[dict]) -> str:
    tid = new_id("trc")
    with engine().begin() as c:
        c.execute(insert(traces).values(id=tid, org_id=org_id, project_id=project_id, interface=interface,
                                        environment=environment, operation=operation, client=client, status=status,
                                        duration_ms=duration_ms, spans=spans, created_at=now()))
    return tid


def list_traces(org_id: str, limit: int = 200, project_id: str | None = None) -> list[dict]:
    q = select(traces).where(traces.c.org_id == org_id)
    if project_id:
        q = q.where(traces.c.project_id == project_id)
    q = q.order_by(traces.c.created_at.desc()).limit(limit)
    with engine().connect() as c:
        return [_row(r) for r in c.execute(q).all()]


def dumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def iter_kinds(org_id: str, kinds: Iterable[str]) -> dict[str, list[dict]]:
    return {k: list_records(k, org_id) for k in kinds}
