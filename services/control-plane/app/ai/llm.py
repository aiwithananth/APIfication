"""Model Provider Hub client.

One internal message format, converted per provider protocol:
  {"role": "user"|"assistant"|"tool", "content": str,
   "tool_calls": [{"id","name","arguments"}], "tool_call_id": str}

Supported protocols: OpenAI chat completions (OpenAI, Azure OpenAI, Ollama and
any OpenAI-compatible gateway) and Anthropic Messages. The `builtin` provider
means "no external model": callers fall back to deterministic logic.
"""
from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from .. import db
from ..config import EGRESS_ALLOWLIST, ORG_ID
from ..vault import vault

DEFAULT_URLS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "ollama": "http://localhost:11434/v1",
}


class LLMError(Exception):
    pass


def get_provider(provider_id: str | None) -> dict | None:
    if provider_id:
        p = db.get_record("model_provider", provider_id)
        if p and p.get("status", "active") == "active":
            return p
    return None


def default_provider() -> dict | None:
    provs = [p for p in db.list_records("model_provider", ORG_ID) if p.get("status", "active") == "active"]
    d = next((p for p in provs if p.get("is_default") and p.get("provider_type") != "builtin"), None)
    return d


def is_external(p: dict | None) -> bool:
    return bool(p) and p.get("provider_type") != "builtin" and bool(p.get("model"))


def _check_egress(url: str) -> None:
    host = urlparse(url).hostname or ""
    if "*" in EGRESS_ALLOWLIST:
        return
    if host not in EGRESS_ALLOWLIST and host not in ("localhost", "127.0.0.1"):
        raise LLMError(f"Endpoint host {host} is not on the egress allowlist")


def _openai_messages(messages: list[dict], system: str | None) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": system}] if system else []
    for m in messages:
        if m["role"] == "tool":
            out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"]})
        elif m["role"] == "assistant" and m.get("tool_calls"):
            out.append({"role": "assistant", "content": m.get("content") or None, "tool_calls": [
                {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])}}
                for tc in m["tool_calls"]]})
        else:
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _anthropic_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        if m["role"] == "tool":
            block = {"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
        elif m["role"] == "assistant" and m.get("tool_calls"):
            blocks: list[dict] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["arguments"]})
            out.append({"role": "assistant", "content": blocks})
        else:
            out.append({"role": m["role"], "content": m["content"]})
    return out


def complete(provider: dict, messages: list[dict], *, system: str | None = None, tools: list[dict] | None = None,
             temperature: float = 0.2, max_tokens: int | None = None, json_mode: bool = False) -> dict[str, Any]:
    """Returns {"text": str, "tool_calls": [...], "usage": {...}, "latency_ms": int}."""
    ptype = provider.get("provider_type")
    if ptype == "builtin" or not provider.get("model"):
        raise LLMError("Built-in provider has no external model")
    base = (provider.get("base_url") or DEFAULT_URLS.get(ptype, "")).rstrip("/")
    if not base:
        raise LLMError("Provider has no base URL")
    _check_egress(base)
    key = vault.get(provider.get("secret_ref", "")) or ""
    headers = {"content-type": "application/json", **(provider.get("headers") or {})}
    max_tokens = max_tokens or int(provider.get("max_tokens") or 2048)
    timeout = float(provider.get("timeout_s") or 60)
    t0 = time.perf_counter()
    try:
        if ptype == "anthropic":
            headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            body: dict[str, Any] = {"model": provider["model"], "max_tokens": max_tokens, "temperature": temperature,
                                    "messages": _anthropic_messages(messages)}
            if system:
                body["system"] = system
            if tools:
                body["tools"] = [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools]
            r = httpx.post(f"{base}/v1/messages", headers=headers, json=body, timeout=timeout)
            if r.status_code >= 400:
                raise LLMError(f"{r.status_code}: {r.text[:300]}")
            data = r.json()
            text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
            calls = [{"id": b["id"], "name": b["name"], "arguments": b.get("input") or {}}
                     for b in data.get("content", []) if b.get("type") == "tool_use"]
            usage = data.get("usage", {})
        else:
            if ptype == "azure_openai":
                headers["api-key"] = key
                url = base if "chat/completions" in base else f"{base}/chat/completions"
            else:
                if key:
                    headers["authorization"] = f"Bearer {key}"
                url = f"{base}/chat/completions"
            body = {"model": provider["model"], "messages": _openai_messages(messages, system),
                    "temperature": temperature, "max_tokens": max_tokens}
            if tools:
                body["tools"] = [{"type": "function", "function": t} for t in tools]
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            r = httpx.post(url, headers=headers, json=body, timeout=timeout)
            if r.status_code >= 400:
                raise LLMError(f"{r.status_code}: {r.text[:300]}")
            data = r.json()
            msg = data["choices"][0]["message"]
            text = msg.get("content") or ""
            calls = []
            for tc in msg.get("tool_calls") or []:
                try:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                calls.append({"id": tc["id"], "name": tc["function"]["name"], "arguments": args})
            usage = data.get("usage", {})
    except httpx.HTTPError as e:
        raise LLMError(f"Connection failed: {e}") from e
    latency = int((time.perf_counter() - t0) * 1000)
    db.put_record("usage_record", ORG_ID, {"name": provider.get("name"), "provider_id": provider["id"],
                                           "model": provider["model"], "latency_ms": latency, "usage": usage})
    return {"text": text, "tool_calls": calls, "usage": usage, "latency_ms": latency}


def complete_text(provider: dict, messages: list[dict], system: str | None = None, **kw) -> str:
    return complete(provider, messages, system=system, **kw)["text"]


def complete_json(provider: dict, prompt: str, system: str) -> dict | None:
    try:
        text = complete(provider, [{"role": "user", "content": prompt}], system=system,
                        json_mode=provider.get("provider_type") in ("openai", "openai_compatible", "ollama"))["text"]
    except LLMError:
        return None
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e < 0:
        return None
    try:
        return json.loads(text[s:e + 1])
    except json.JSONDecodeError:
        return None


def test_provider(provider: dict) -> dict:
    """Connectivity + capability probe. Stores tested capability flags instead of trusting the URL format."""
    results: list[dict] = []
    caps: list[str] = []
    if provider.get("provider_type") == "builtin":
        return {"ok": True, "checks": [{"name": "Built-in deterministic engine", "ok": True}], "capabilities": ["text"]}
    try:
        r = complete(provider, [{"role": "user", "content": "Reply with the single word OK."}], max_tokens=16)
        results.append({"name": "Authentication & text completion", "ok": True, "detail": f"{r['latency_ms']} ms"})
        caps.append("text")
    except LLMError as e:
        return {"ok": False, "checks": [{"name": "Authentication & text completion", "ok": False, "detail": str(e)}],
                "capabilities": []}
    try:
        tool = {"name": "get_time", "description": "Returns the time", "parameters": {"type": "object", "properties": {}}}
        r = complete(provider, [{"role": "user", "content": "Call the get_time tool."}], tools=[tool], max_tokens=64)
        ok = bool(r["tool_calls"])
        results.append({"name": "Tool calling", "ok": ok, "detail": "supported" if ok else "no tool call returned"})
        if ok:
            caps.append("tool_calling")
    except LLMError as e:
        results.append({"name": "Tool calling", "ok": False, "detail": str(e)[:120]})
    js = complete_json(provider, 'Return {"ok": true} as JSON.', "Return only JSON.")
    results.append({"name": "Structured JSON output", "ok": bool(js), "detail": "parsed" if js else "not parseable"})
    if js:
        caps.append("structured_output")
    return {"ok": True, "checks": results, "capabilities": caps}
