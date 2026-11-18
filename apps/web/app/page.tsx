"use client";

import clsx from "clsx";
import { ArrowRight, CheckSquare, Database, Sparkles } from "lucide-react";
import Link from "next/link";

import { useApp } from "@/components/AppContext";
import { Badge, Button, Empty, PageHeader, Panel, Spinner, StatusDot, statusTone } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/api";

export default function Overview() {
  const { data: o, isLoading } = useApi<any>("/v1/overview", { refreshInterval: 10000 });
  const { data: caps } = useApi<any[]>("/v1/capabilities");
  const { askAssistant } = useApp();
  if (isLoading || !o) return <Spinner />;
  const iface = o.by_interface || {};
  const total = Math.max(1, (iface.rest || 0) + (iface.graphql || 0) + (iface.mcp || 0));

  return (
    <>
      <PageHeader
        title="Overview"
        description="Every capability is defined once, governed centrally and exposed through REST, GraphQL and MCP."
        actions={<>
          <Button onClick={() => askAssistant("Show platform status")} icon={<Sparkles className="h-3.5 w-3.5" />}>Ask for a summary</Button>
          <Link href="/build"><Button variant="primary">Create capability</Button></Link>
        </>}
      />

      {/* three-layer band */}
      <div className="panel grid grid-cols-1 lg:grid-cols-[1fr_auto_1.2fr_auto_1fr]">
        <Layer title="Data access" sub="Layer 3 · connectors" href="/connectors">
          {o.connector_health.length === 0 && <p className="text-sm text-ink-3">No connectors yet.</p>}
          <ul className="space-y-1.5">
            {o.connector_health.slice(0, 4).map((c: any) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <StatusDot tone={c.status === "healthy" ? "good" : c.status === "failing" ? "bad" : "neutral"} />
                <Link href={`/connectors/${c.id}`} className="truncate hover:underline">{c.name}</Link>
                <span className="text-2xs text-ink-4">{c.type}</span>
                <span className="ml-auto text-2xs text-ink-4">{c.read_only ? "read-only" : "read/write"}</span>
              </li>
            ))}
          </ul>
        </Layer>
        <Arrow />
        <Layer title="Business capabilities" sub="Layer 2 · one canonical spec each" href="/capabilities">
          <div className="flex items-baseline gap-5">
            <Big n={o.counts.capability} label="capabilities" />
            <Big n={o.operations} label="operations" />
            <Big n={o.active_deployments.length} label="live deployments" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(caps || []).slice(0, 4).map((c) => (
              <Link key={c.id} href={`/capabilities/${c.id}`} className="text-xs px-2 h-6 inline-flex items-center rounded-sm bg-paper hover:bg-line-2">
                {c.name}
              </Link>
            ))}
          </div>
        </Layer>
        <Arrow />
        <Layer title="Interfaces" sub="Layer 1 · projections" href="/portal">
          <ul className="space-y-2 text-sm">
            <IfaceRow color="bg-rest" label="REST operations" n={o.rest_operations} />
            <IfaceRow color="bg-gql" label="GraphQL fields" n={o.graphql_fields} />
            <IfaceRow color="bg-mcp" label="MCP tools" n={o.mcp_tools} />
          </ul>
        </Layer>
      </div>

      <div className="mt-5 grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Panel title="Gateway traffic" className="xl:col-span-2" actions={<Link href="/monitoring" className="text-xs text-signal-2 hover:underline">Open traces</Link>}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric label="Requests" value={o.requests} />
            <Metric label="Denied by policy or auth" value={o.denials} tone={o.denials ? "warn" : undefined} />
            <Metric label="Server errors" value={o.errors} tone={o.errors ? "bad" : undefined} />
            <Metric label="Latency p50 / p95" value={`${o.latency.p50} / ${o.latency.p95} ms`} />
          </div>
          <div className="mt-4">
            <div className="text-xs text-ink-3 mb-1.5">Requests by interface</div>
            <div className="flex h-2.5 rounded-full overflow-hidden bg-paper">
              <div className="bg-rest" style={{ width: `${((iface.rest || 0) / total) * 100}%` }} />
              <div className="bg-gql" style={{ width: `${((iface.graphql || 0) / total) * 100}%` }} />
              <div className="bg-mcp" style={{ width: `${((iface.mcp || 0) / total) * 100}%` }} />
            </div>
            <div className="mt-1.5 flex gap-4 text-2xs text-ink-3">
              <span>REST {iface.rest || 0}</span><span>GraphQL {iface.graphql || 0}</span><span>MCP {iface.mcp || 0}</span>
            </div>
          </div>
          <div className="mt-4 -mx-4 -mb-4 border-t border-line">
            {o.recent_traces.length === 0 ? (
              <Empty title="No traffic yet">Call a published endpoint from the Developer Portal or MCP Studio to see traces here.</Empty>
            ) : (
              <table className="tbl">
                <thead><tr><th>Interface</th><th>Operation</th><th>Client</th><th>Status</th><th className="text-right">Time</th></tr></thead>
                <tbody>
                  {o.recent_traces.map((t: any) => (
                    <tr key={t.id}>
                      <td><Badge tone={t.interface === "rest" ? "rest" : t.interface === "graphql" ? "gql" : "mcp"}>{t.interface}</Badge></td>
                      <td className="font-mono text-xs">{t.operation}</td>
                      <td className="text-ink-3">{t.client || "anonymous"}</td>
                      <td><Badge tone={t.status < 300 ? "good" : t.status < 500 ? "warn" : "bad"}>{t.status}</Badge></td>
                      <td className="text-right text-ink-4 text-xs">{timeAgo(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel title="Needs your attention" bodyClass="p-0">
            {o.pending_approvals.length === 0 ? (
              <div className="px-4 py-5 text-sm text-ink-3 flex items-center gap-2"><CheckSquare className="h-4 w-4" /> No pending approvals.</div>
            ) : (
              <ul>
                {o.pending_approvals.slice(0, 5).map((a: any) => (
                  <li key={a.id} className="px-4 py-2.5 border-b border-line-2 last:border-0">
                    <Link href="/approvals" className="text-sm font-medium hover:underline">{a.name}</Link>
                    <div className="text-2xs text-ink-4">{a.kind === "release" ? "Production release" : "Held operation"} · {a.requested_by} · {timeAgo(a.created_at)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Live deployments" bodyClass="p-0">
            {o.active_deployments.length === 0 ? (
              <div className="px-4 py-5 text-sm text-ink-3">Nothing is deployed yet.</div>
            ) : (
              <ul>
                {o.active_deployments.map((d: any) => (
                  <li key={d.id} className="px-4 py-2.5 border-b border-line-2 last:border-0 flex items-center gap-2">
                    <span className={clsx("h-2 w-2 rounded-full", d.environment === "production" ? "bg-danger" : d.environment === "staging" ? "bg-warn" : "bg-signal")} />
                    <Link href={`/capabilities/${d.capability_id}`} className="text-sm truncate hover:underline">{d.capability_name}</Link>
                    <span className="ml-auto text-2xs text-ink-4">r{d.revision_number} · {d.environment}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Recent test runs" bodyClass="p-0">
            {o.last_test_runs.length === 0 ? <div className="px-4 py-5 text-sm text-ink-3">No test runs yet.</div> : (
              <ul>
                {o.last_test_runs.map((r: any) => (
                  <li key={r.id} className="px-4 py-2.5 border-b border-line-2 last:border-0 flex items-center gap-2">
                    <Badge tone={statusTone(r.status)}>{r.passed}/{r.total}</Badge>
                    <Link href={`/testing?run=${r.id}`} className="text-sm truncate hover:underline">{r.name}</Link>
                    <span className="ml-auto text-2xs text-ink-4">{timeAgo(r.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {o.counts.connector === 0 && (
        <Panel className="mt-5" title="Get started">
          <div className="flex items-center gap-3 text-sm">
            <Database className="h-4 w-4 text-ink-3" /> Register a database, then describe your first API in one sentence.
            <Link href="/connectors/new" className="ml-auto"><Button variant="primary">Register connector</Button></Link>
          </div>
        </Panel>
      )}
    </>
  );
}

function Layer({ title, sub, href, children }: { title: string; sub: string; href: string; children: React.ReactNode }) {
  return (
    <div className="p-4 min-w-0">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <Link href={href} className="text-sm font-semibold hover:underline">{title}</Link>
          <div className="text-2xs text-ink-4">{sub}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function Arrow() {
  return <div className="hidden lg:flex items-center text-line"><ArrowRight className="h-5 w-5 text-ink-4/60" /></div>;
}

function Big({ n, label }: { n: number; label: string }) {
  return <div><div className="text-2xl font-semibold tabular-nums">{n}</div><div className="text-2xs text-ink-4">{label}</div></div>;
}

function IfaceRow({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <li className="flex items-center gap-2">
      <span className={clsx("h-3 w-1 rounded-full", color)} />
      <span>{label}</span>
      <span className="ml-auto font-semibold tabular-nums">{n}</span>
    </li>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div>
      <div className="text-xs text-ink-3">{label}</div>
      <div className={clsx("text-lg font-semibold tabular-nums", tone === "bad" && "text-danger", tone === "warn" && "text-warn")}>{value}</div>
    </div>
  );
}
