"use client";

import clsx from "clsx";
import { BookOpen, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { useApp } from "@/components/AppContext";
import { callAs, ClientPicker } from "@/components/ClientPicker";
import { MethodTag, ProjectionStrip } from "@/components/ProjectionStrip";
import { Badge, Button, CodeBlock, Empty, Field, PageHeader, Panel, Spinner, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";

export default function Portal() {
  const { env } = useApp();
  const { data: deps, isLoading } = useApi<any[]>("/v1/deployments");
  const live = (deps || []).filter((d) => d.status === "active" && d.environment === env);
  const [sel, setSel] = useState("");
  const d = live.find((x) => x.id === sel) || live[0];
  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="Developer portal" description="Documentation and a live console for every capability deployed to the selected environment." />
      {!live.length ? <div className="panel"><Empty icon={<BookOpen className="h-6 w-6" />} title={`Nothing is deployed to ${env}`}>Deploy a capability, or switch environment in the top bar.</Empty></div> : (
        <div className="grid grid-cols-1 xl:grid-cols-[240px_1fr] gap-5 items-start">
          <Panel title={`Live in ${env}`} bodyClass="p-2">
            <ul>{live.map((x) => (
              <li key={x.id}><button onClick={() => setSel(x.id)} className={clsx("w-full text-left px-2 py-1.5 rounded", x.id === d?.id ? "bg-signal-soft" : "hover:bg-paper")}>
                <div className="text-sm font-medium">{x.capability_name}</div><div className="text-2xs text-ink-4">r{x.revision_number}</div>
              </button></li>
            ))}</ul>
          </Panel>
          {d && <Docs key={d.id} dep={d} env={env} />}
        </div>
      )}
    </>
  );
}

function Docs({ dep, env }: { dep: any; env: string }) {
  const { data: rev } = useApi<any>(`/v1/capabilities/${dep.capability_id}/revisions/${dep.revision_id}`);
  const { data: proj } = useApi<any>(`/v1/projects/${dep.project_id}`);
  const [tab, setTab] = useState<"rest" | "graphql" | "mcp">("rest");
  const [client, setClient] = useState("");
  const [opId, setOpId] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  useEffect(() => { if (rev && !opId) setOpId(rev.spec.operations[0]?.id); }, [rev, opId]);
  if (!rev || !proj) return <Spinner />;
  const spec = rev.spec;
  const base = `${origin}/gw/${env}/${proj.slug}`;
  const op = spec.operations.find((o: any) => o.id === opId) || spec.operations[0];
  const rest = op?.interfaces.find((i: any) => i.kind === "rest");

  function buildPath() {
    let p = rest.path;
    const q: string[] = [];
    for (const prm of op.params) {
      const v = inputs[prm.name];
      if (!v) continue;
      if (prm.location === "path") p = p.replace(`{${prm.name}}`, encodeURIComponent(v));
      if (prm.location === "query") q.push(`${prm.name}=${encodeURIComponent(v)}`);
    }
    return p + (q.length ? `?${q.join("&")}` : "");
  }
  const body = Object.fromEntries(op?.params.filter((p: any) => p.location === "body" && inputs[p.name]).map((p: any) => [p.name, inputs[p.name]]) || []);

  return (
    <div className="space-y-5 min-w-0">
      <Panel>
        <div className="flex items-start justify-between gap-4">
          <div><div className="text-lg font-semibold">{spec.capability.name}</div><p className="text-sm text-ink-3 max-w-[72ch]">{spec.capability.description}</p></div>
          <ProjectionStrip interfaces={Array.from(new Set(spec.operations.flatMap((o: any) => o.interfaces.map((i: any) => i.kind))))} />
        </div>
        <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
          <dt className="text-ink-3">REST base</dt><dd className="font-mono text-xs">{base}/api</dd>
          <dt className="text-ink-3">GraphQL</dt><dd className="font-mono text-xs">{base}/graphql</dd>
          <dt className="text-ink-3">OpenAPI</dt><dd><a className="text-signal-2 underline text-xs" href={`/api/v1/capabilities/${dep.capability_id}/openapi.json?revision_id=${dep.revision_id}&server=${encodeURIComponent(base + "/api")}`} target="_blank">openapi.json</a></dd>
          <dt className="text-ink-3">Authentication</dt><dd className="text-xs">OAuth2 bearer token from an API client (Security → API clients). Tenant and roles come from the client identity.</dd>
          <dt className="text-ink-3">Revision</dt><dd className="text-xs">r{rev.number} · {rev.digest.slice(0, 23)}…</dd>
        </dl>
      </Panel>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "rest", label: "REST" }, { id: "graphql", label: "GraphQL" }, { id: "mcp", label: "MCP" }]} />
      {tab === "rest" && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-5">
          <Panel title="Operations" bodyClass="p-0">
            <ul className="divide-y divide-line-2">{spec.operations.filter((o: any) => o.interfaces.some((i: any) => i.kind === "rest")).map((o: any) => {
              const r = o.interfaces.find((i: any) => i.kind === "rest");
              return (
                <li key={o.id}><button onClick={() => { setOpId(o.id); setInputs({}); setRes(null); }} className={clsx("w-full text-left px-4 py-3", o.id === op.id && "bg-signal-soft/40")}>
                  <div className="flex items-center gap-2"><MethodTag method={r.method} /><span className="font-mono text-xs">{r.path}</span></div>
                  <div className="mt-1 text-sm">{o.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">{o.required_scopes.map((s: string) => <Badge key={s} className="font-mono">{s}</Badge>)}{o.approval_required && <Badge tone="warn">202 pending approval</Badge>}</div>
                </button></li>
              );
            })}</ul>
          </Panel>
          {rest && (
            <Panel title="Try it">
              <div className="space-y-3">
                <Field label="Call as API client"><ClientPicker value={client} onChange={setClient} /></Field>
                {op.params.map((p: any) => (
                  <Field key={p.name} label={`${p.name}${p.required || p.location === "path" ? " *" : ""} · ${p.location}`} hint={p.description}>
                    <input className="input" value={inputs[p.name] || ""} onChange={(e) => setInputs({ ...inputs, [p.name]: e.target.value })}
                      placeholder={p.name.endsWith("_id") ? "CUS-1003" : p.name === "q" ? "smith" : ""} />
                  </Field>
                ))}
                <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} disabled={!client} loading={busy} onClick={async () => {
                  setBusy(true);
                  try { setRes(await callAs(client, `/gw/${env}/${proj.slug}/api${buildPath()}`, { method: rest.method, ...(Object.keys(body).length ? { json: body } : {}) })); }
                  finally { setBusy(false); }
                }}>Send {rest.method}</Button>
                <CodeBlock dark code={`curl -X ${rest.method} "${base}/api${buildPath()}" \\\n  -H "Authorization: Bearer $APF_TOKEN"${Object.keys(body).length ? ` \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify(body)}'` : ""}`} />
                {res && (
                  <div>
                    <div className="flex items-center gap-2 mb-1.5 text-xs"><Badge tone={res.status < 300 ? "good" : res.status < 500 ? "warn" : "bad"}>{res.status}</Badge><span className="text-ink-4">{res.ms} ms</span>{res.trace && <a href="/monitoring" className="text-signal-2 underline">trace</a>}</div>
                    <CodeBlock code={JSON.stringify(res.body, null, 2)} maxHeight={360} />
                  </div>
                )}
              </div>
            </Panel>
          )}
        </div>
      )}
      {tab === "graphql" && (
        <Panel title="GraphQL examples">
          {spec.operations.filter((o: any) => o.interfaces.some((i: any) => i.kind === "graphql")).map((o: any) => {
            const g = o.interfaces.find((i: any) => i.kind === "graphql");
            const args = o.params.map((p: any) => `${p.name}: ${p.type === "integer" ? 5 : `"…"`}`).join(", ");
            return (
              <div key={o.id} className="mb-4">
                <div className="text-sm font-medium mb-1">{o.name} <span className="text-2xs text-ink-4">{g.operation}</span></div>
                <CodeBlock code={`${g.operation === "mutation" ? "mutation" : "query"} {\n  ${g.field}${args ? `(${args})` : ""} { id }\n}`} />
              </div>
            );
          })}
          <p className="text-xs text-ink-3">Query depth ≤ 6, aliases ≤ 15. Introspection is disabled in production. Use GraphQL Studio for a live console.</p>
        </Panel>
      )}
      {tab === "mcp" && (
        <Panel title="MCP">
          <p className="text-sm text-ink-3 mb-3">MCP tools for this capability are published through MCP servers. Connect an MCP client to the server URL with a bearer token from an allowed API client.</p>
          <CodeBlock code={`POST ${origin}/gw/${env}/mcp/<server-slug>\nAuthorization: Bearer $APF_TOKEN\n\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}`} />
        </Panel>
      )}
    </div>
  );
}
