"""Connector runtime (Layer 3).

Connectors run server-side only. The browser never opens a database
connection and never receives credentials; secrets are resolved from the
vault by the runtime at execution time.
"""
from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx

from ..vault import vault

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_ROWS = 1000


class ConnectorError(Exception):
    pass


def _ident(name: str) -> str:
    parts = name.split(".")
    for p in parts:
        if not IDENT.match(p):
            raise ConnectorError(f"Illegal identifier: {name!r}")
    return ".".join(f'"{p}"' for p in parts)


class SqlConnector:
    """Shared parameterised SQL generation. Identifiers are validated, values are always bound."""
    placeholder = "?"

    def __init__(self, record: dict[str, Any]):
        self.record = record
        self.read_only = record.get("read_only", True)

    # subclasses implement _connect, _discover
    def _connect(self):  # pragma: no cover
        raise NotImplementedError

    def _ph(self, i: int) -> str:
        return self.placeholder

    def _rows(self, cur) -> list[dict]:
        cols = [d[0] for d in cur.description] if cur.description else []
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def test(self) -> dict:
        t0 = time.perf_counter()
        try:
            with self._connect() as conn:
                cur = conn.cursor()
                cur.execute("SELECT 1")
                cur.fetchall()
            return {"ok": True, "latency_ms": int((time.perf_counter() - t0) * 1000), "checks": self.checks()}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": _safe_error(e), "latency_ms": int((time.perf_counter() - t0) * 1000), "checks": self.checks()}

    def checks(self) -> list[dict]:
        return []

    def select(self, resource: str, fields: list[str], where: list[tuple[str, str, Any]], *, limit: int = 100,
               search: tuple[list[str], str] | None = None) -> list[dict]:
        cols = ", ".join(_ident(f) for f in fields) if fields else "*"
        sql = f"SELECT {cols} FROM {_ident(resource)}"
        clauses, args = [], []
        for f, op, v in where:
            if op not in ("=", "!=", ">", "<", ">=", "<="):
                raise ConnectorError("Unsupported operator")
            clauses.append(f"{_ident(f)} {op} {self._ph(len(args))}")
            args.append(v)
        if search and search[1]:
            sub = []
            for f in search[0]:
                sub.append(f"LOWER(CAST({_ident(f)} AS TEXT)) LIKE {self._ph(len(args))}")
                args.append(f"%{str(search[1]).lower()}%")
            if sub:
                clauses.append("(" + " OR ".join(sub) + ")")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += f" LIMIT {int(min(max(limit, 1), MAX_ROWS))}"
        with self._connect() as conn:
            cur = conn.cursor()
            cur.execute(sql, args)
            return self._rows(cur)

    def update(self, resource: str, key_field: str, key: Any, values: dict[str, Any],
               where: list[tuple[str, str, Any]]) -> dict | None:
        if self.read_only:
            raise ConnectorError("Connector is read-only")
        if not values:
            raise ConnectorError("No updatable fields supplied")
        sets, args = [], []
        for k, v in values.items():
            sets.append(f"{_ident(k)} = {self._ph(len(args))}")
            args.append(v)
        clauses = [f"{_ident(key_field)} = {self._ph(len(args))}"]
        args.append(key)
        for f, op, v in where:
            clauses.append(f"{_ident(f)} {op} {self._ph(len(args))}")
            args.append(v)
        sql = f"UPDATE {_ident(resource)} SET {', '.join(sets)} WHERE {' AND '.join(clauses)}"
        with self._connect() as conn:
            cur = conn.cursor()
            cur.execute(sql, args)
            if cur.rowcount == 0:
                return None
            conn.commit()
        rows = self.select(resource, [], [(key_field, "=", key)], limit=1)
        return rows[0] if rows else None

    def insert(self, resource: str, values: dict[str, Any]) -> dict:
        if self.read_only:
            raise ConnectorError("Connector is read-only")
        cols = ", ".join(_ident(k) for k in values)
        phs = ", ".join(self._ph(i) for i in range(len(values)))
        with self._connect() as conn:
            cur = conn.cursor()
            cur.execute(f"INSERT INTO {_ident(resource)} ({cols}) VALUES ({phs})", list(values.values()))
            conn.commit()
        return values


class SqliteConnector(SqlConnector):
    placeholder = "?"

    def _path(self) -> Path:
        p = Path(self.record.get("database", ""))
        if self.record.get("hosting") != "local_development":
            raise ConnectorError("SQLite connectors are only allowed for local development")
        return p

    def _connect(self):
        p = self._path()
        if not p.exists():
            raise ConnectorError("Database file not found")
        uri = f"file:{p}?mode={'ro' if self.read_only else 'rw'}"
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        return _Closing(conn)

    def checks(self) -> list[dict]:
        return [{"name": "Local development only", "ok": self.record.get("hosting") == "local_development"},
                {"name": "Read-only mode", "ok": True, "detail": "read-only" if self.read_only else "write enabled"}]

    def discover(self) -> dict:
        with self._connect() as conn:
            cur = conn.cursor()
            cur.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            objs = cur.fetchall()
            tables = []
            for name, typ in objs:
                cur.execute(f"PRAGMA table_info({_ident(name)})")
                cols = [{"name": r[1], "type": _norm_type(r[2]), "native_type": r[2], "nullable": not r[3], "primary_key": bool(r[5])}
                        for r in cur.fetchall()]
                cur.execute(f"PRAGMA foreign_key_list({_ident(name)})")
                fks = [{"column": r[3], "references": f"{r[2]}.{r[4]}"} for r in cur.fetchall()]
                tables.append({"name": name, "kind": typ, "columns": cols, "foreign_keys": fks})
        return {"schemas": [{"name": "main", "tables": tables}]}


class PostgresConnector(SqlConnector):
    placeholder = "%s"

    def _connect(self):
        try:
            import psycopg
        except ImportError as e:  # pragma: no cover
            raise ConnectorError("psycopg is not installed") from e
        r = self.record
        password = vault.get(r.get("secret_ref", "")) or None
        sslmode = r.get("tls_mode", "verify-full")
        options = f"-c statement_timeout={int(r.get('options', {}).get('statement_timeout_ms', 5000))}"
        if self.read_only:
            options += " -c default_transaction_read_only=on"
        return psycopg.connect(host=r.get("host"), port=r.get("port") or 5432, dbname=r.get("database"),
                               user=r.get("username"), password=password, sslmode=sslmode,
                               connect_timeout=5, options=options, application_name="apification-connector")

    def checks(self) -> list[dict]:
        tls = self.record.get("tls_mode", "verify-full")
        return [{"name": "TLS certificate verification", "ok": tls in ("verify-full", "verify-ca"), "detail": tls},
                {"name": "Read-only transactions", "ok": True, "detail": "enforced" if self.read_only else "write enabled"},
                {"name": "Credential in vault", "ok": bool(self.record.get("secret_ref"))}]

    def discover(self) -> dict:
        sql = """
        SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable,
               EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                       JOIN information_schema.key_column_usage k ON tc.constraint_name = k.constraint_name
                        AND tc.table_schema = k.table_schema
                       WHERE tc.constraint_type = 'PRIMARY KEY' AND k.table_schema = c.table_schema
                         AND k.table_name = c.table_name AND k.column_name = c.column_name) AS pk
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position"""
        with self._connect() as conn:
            cur = conn.cursor()
            cur.execute(sql)
            rows = cur.fetchall()
        schemas: dict[str, dict[str, dict]] = {}
        for sch, tbl, ttype, col, dtype, nullable, pk in rows:
            t = schemas.setdefault(sch, {}).setdefault(tbl, {"name": tbl if sch == "public" else f"{sch}.{tbl}",
                                                               "kind": "view" if ttype == "VIEW" else "table",
                                                               "columns": [], "foreign_keys": []})
            t["columns"].append({"name": col, "type": _norm_type(dtype), "native_type": dtype,
                                 "nullable": nullable == "YES", "primary_key": bool(pk)})
        return {"schemas": [{"name": s, "tables": list(ts.values())} for s, ts in schemas.items()]}


class RestApiConnector:
    def __init__(self, record: dict[str, Any]):
        self.record = record
        self.read_only = record.get("read_only", True)

    def test(self) -> dict:
        t0 = time.perf_counter()
        url = self.record.get("base_url", "")
        try:
            headers = {}
            tok = vault.get(self.record.get("secret_ref", ""))
            if tok:
                headers["Authorization"] = f"Bearer {tok}"
            r = httpx.get(url, headers=headers, timeout=5)
            return {"ok": r.status_code < 500, "status": r.status_code, "latency_ms": int((time.perf_counter() - t0) * 1000),
                    "checks": [{"name": "HTTPS", "ok": url.startswith("https://")}]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": _safe_error(e), "latency_ms": int((time.perf_counter() - t0) * 1000), "checks": []}

    def discover(self) -> dict:
        return {"schemas": []}


class _Closing:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, *a):
        self.conn.close()


def _norm_type(t: str) -> str:
    t = (t or "").lower()
    if any(x in t for x in ("int", "serial")):
        return "integer"
    if any(x in t for x in ("real", "double", "numeric", "decimal", "float")):
        return "number"
    if "bool" in t:
        return "boolean"
    if any(x in t for x in ("time", "date")):
        return "datetime"
    if "json" in t:
        return "json"
    return "string"


def _safe_error(e: Exception) -> str:
    msg = str(e).splitlines()[0] if str(e) else e.__class__.__name__
    # never echo credentials embedded in driver messages
    return re.sub(r"password=\S+", "password=•••", msg)[:300]


SUPPORTED = {"sqlite": SqliteConnector, "postgresql": PostgresConnector, "rest_api": RestApiConnector,
             "graphql_api": RestApiConnector}
PLANNED = ["mysql", "sqlserver", "oracle", "mongodb", "snowflake", "bigquery"]


def get_connector(record: dict[str, Any]):
    cls = SUPPORTED.get(record.get("type", ""))
    if not cls:
        raise ConnectorError(f"Connector type '{record.get('type')}' is planned but not yet production-supported")
    return cls(record)


# --------------------------------------------------------------------------- classification suggestions

SENSITIVE_HINTS = [
    (re.compile(r"(card|pan|cc_?num|cvv|iban|account_?number)", re.I), "restricted", False),
    (re.compile(r"(ssn|tax_?id|national_?id|passport|government)", re.I), "restricted", False),
    (re.compile(r"(password|secret|token|api_?key|hash)", re.I), "restricted", False),
    (re.compile(r"(risk|fraud|score|internal_note)", re.I), "confidential", False),
    (re.compile(r"(email|phone|mobile|address|dob|birth)", re.I), "confidential", True),
]


def suggest_classification(column: str) -> dict:
    for rx, cls, exposed in SENSITIVE_HINTS:
        if rx.search(column):
            return {"classification": cls, "exposed": exposed,
                    "reason": f"Column name suggests {cls} data"}
    return {"classification": "internal", "exposed": True, "reason": ""}
