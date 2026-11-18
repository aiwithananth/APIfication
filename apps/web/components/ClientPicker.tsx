"use client";

import { api, post, useApi } from "@/lib/api";
import { Select } from "./ui";

export function ClientPicker({ value, onChange, kind }: { value: string; onChange: (v: string) => void; kind?: string }) {
  const { data } = useApi<any[]>("/v1/api-clients");
  const list = (data || []).filter((c) => c.status === "active" && (!kind || c.kind === kind || kind === "any"));
  return (
    <Select value={value} onChange={onChange} placeholder="Call as…"
      options={list.map((c) => ({ value: c.id, label: `${c.name} · ${c.roles.join(",") || "no role"}` }))} />
  );
}

/** Exchange the platform session for a 10-minute token scoped to an API client, then call the gateway. */
export async function callAs(clientId: string, path: string, init: RequestInit & { json?: unknown } = {}) {
  const { token } = await post("/v1/console/token", { client_id: clientId });
  const t0 = performance.now();
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: res.status, body, ms: Math.round(performance.now() - t0), trace: res.headers.get("x-apf-trace") };
}

export { api };
