"use client";

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { CAT_COLORS } from "@/lib/colors";
import { Badge, Empty, PageHeader, Panel, Spinner, Tabs } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/api";

const TYPE_CAT: Record<string, string> = {
  "gateway.auth": "entry", "trigger.request": "entry", "security.authorize": "security", "security.approval": "security",
  "data.validate": "logic", "database.select": "data", "database.update": "data", "database.insert": "data", "data.redact": "data",
  "output.response": "output", "output.error": "output", "http.request": "integration", "ai.model_call": "ai",
};

function Monitoring() {
  const sp = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<"traces" | "audit" | "usage">((sp.get("tab") as any) || "traces");
  return (
    <>
      <PageHeader title="Monitoring & audit" description="Client → gateway → policy → workflow → connector, for every REST, GraphQL and MCP request. Audit records who changed what and every policy decision." />
      <Tabs value={tab} onChange={(t) => { setTab(t); router.replace(`/monitoring?tab=${t}`); }} className="mb-5" tabs={[{ id: "traces", label: "Request traces" }, { id: "audit", label: "Audit log" }, { id: "usage", label: "Model usage" }]} />
      {tab === "traces" && <Traces />}
      {tab === "audit" && <Audit />}
      {tab === "usage" && <Usage />}
    </>
  );
}

function Traces() {
  const { data, isLoading } = useApi<any[]>("/v1/traces?limit=150", { refreshInterval: 8000 });
  const [sel, setSel] = useState("");
  const [iface, setIface] = useState("all");
  if (isLoading) return <Spinner />;
  const rows = (data || []).filter((t) => iface === "all" || t.interface === iface);
  const t = rows.find((x) => x.id === sel) || rows[0];
  if (!data?.length) return <div className="panel"><Empty title="No requests yet">Call an endpoint from the Developer Portal, GraphQL Studio or MCP Studio.</Empty></div>;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 items-start">
      <Panel bodyClass="p-0" title="Requests" actions={
        <div className="flex gap-1">{["all", "rest", "graphql", "mcp"].map((i) => (
          <button key={i} onClick={() => setIface(i)} className={clsx("h-6 px-2 rounded text-2xs", iface === i ? "bg-ink text-white" : "text-ink-3 hover:bg-paper")}>{i}</button>
        ))}</div>}>
        <div className="max-h-[640px] overflow-y-auto">
          <table className="tbl"><tbody>{rows.map((r) => (
            <tr key={r.id} onClick={() => setSel(r.id)} className={clsx("cursor-pointer", r.id === t?.id && "bg-signal-soft/50")}>
              <td className="w-16"><Badge tone={r.interface === "rest" ? "rest" : r.interface === "graphql" ? "gql" : "mcp"}>{r.interface}</Badge></td>
              <td><div className="font-mono text-xs truncate max-w-[34ch]">{r.operation}</div><div className="text-2xs text-ink-4">{r.client || "anonymous"} · {r.environment}</div></td>
              <td><Badge tone={r.status < 300 ? "good" : r.status < 500 ? "warn" : "bad"}>{r.status}</Badge></td>
              <td className="text-right text-2xs text-ink-4 whitespace-nowrap">{r.duration_ms} ms<br />{timeAgo(r.created_at)}</td>
            </tr>
          ))}</tbody></table>
        </div>
      </Panel>
      {t && (
        <Panel title="Trace" actions={<span className="font-mono text-2xs text-ink-4">{t.id}</span>}>
          <div className="flex flex-wrap gap-2 mb-4 text-xs">
            <Badge tone={t.interface === "rest" ? "rest" : t.interface === "graphql" ? "gql" : "mcp"}>{t.interface}</Badge>
            <span className="font-mono">{t.operation}</span><span className="text-ink-3">· {t.client}</span><span className="text-ink-3">· {t.duration_ms} ms</span>
          </div>
          <ol className="space-y-0">
            {t.spans.map((s: any, i: number) => {
              const color = CAT_COLORS[TYPE_CAT[s.type] || "logic"];
              return (
                <li key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="h-3 w-3 rounded-sm mt-1" style={{ background: s.status === "stopped" ? "#B42318" : color }} />
                    {i < t.spans.length - 1 && <span className="w-px flex-1 bg-line my-0.5" />}
                  </div>
                  <div className="pb-3 min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{s.label}</span>
                      {s.port && s.port !== "out" && <span className="text-2xs text-ink-4 inline-flex items-center"><ChevronRight className="h-3 w-3" />{s.port}</span>}
                      {s.ms !== undefined && <span className="ml-auto text-2xs text-ink-4 tabular-nums">{s.ms} ms</span>}
                    </div>
                    <div className="text-2xs text-ink-4 font-mono">{s.type}</div>
                    {s.detail && <div className={clsx("text-xs mt-0.5", s.status === "stopped" ? "text-danger" : "text-ink-2")}>{s.detail}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>
      )}
    </div>
  );
}

function Audit() {
  const [action, setAction] = useState("");
  const { data, isLoading } = useApi<any[]>(`/v1/audit-events?limit=300${action ? `&action=${action}` : ""}`);
  return (
    <Panel bodyClass="p-0" title="Audit log" actions={
      <select className="input h-8 w-48 text-xs" value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">All events</option>
        {["policy", "capability", "deployment", "approval", "connector", "api_client", "mcp", "model_provider", "agent", "tests", "assistant", "gateway"].map((a) => <option key={a} value={a}>{a}</option>)}
      </select>}>
      {isLoading ? <Spinner /> : (
        <div className="max-h-[680px] overflow-y-auto">
          <table className="tbl"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Details</th></tr></thead>
            <tbody>{(data || []).map((e) => (
              <tr key={e.id}>
                <td className="text-2xs text-ink-4 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                <td className="text-xs">{e.actor}<div className="text-2xs text-ink-4">{e.actor_type}</div></td>
                <td className="font-mono text-xs">{e.action}</td>
                <td className="font-mono text-2xs text-ink-3 max-w-[24ch] truncate">{e.resource}</td>
                <td><Badge tone={["success", "allow"].includes(e.outcome) ? "good" : e.outcome === "deny" ? "warn" : "bad"}>{e.outcome}</Badge></td>
                <td className="text-2xs text-ink-3 font-mono max-w-[40ch] truncate" title={JSON.stringify(e.details)}>{Object.entries(e.details || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ")}</td>
              </tr>
            ))}</tbody></table>
        </div>
      )}
    </Panel>
  );
}

function Usage() {
  const { data } = useApi<any[]>("/v1/usage");
  if (!data) return <Spinner />;
  return (
    <Panel bodyClass="p-0" title="Model usage" description="Recorded per provider and model. Prompts and outputs are not stored.">
      {!data.length ? <Empty title="No model calls yet">Usage appears once a model provider is configured and used by the assistant or agents.</Empty> : (
        <table className="tbl"><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Avg latency</th></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.provider + u.model}><td>{u.provider}</td><td className="font-mono text-xs">{u.model}</td><td className="tabular-nums">{u.calls}</td>
              <td className="tabular-nums">{u.input_tokens}</td><td className="tabular-nums">{u.output_tokens}</td><td className="tabular-nums">{u.avg_latency_ms} ms</td></tr>
          ))}</tbody></table>
      )}
    </Panel>
  );
}

export default function Page() { return <Suspense><Monitoring /></Suspense>; }
