"use client";

import { Boxes, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useApp } from "@/components/AppContext";
import { callAs, ClientPicker } from "@/components/ClientPicker";
import { CodeView } from "@/components/CodeView";
import { Badge, Button, CodeBlock, Empty, Field, PageHeader, Panel, Select, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";

export default function GraphQLStudio() {
  const { env } = useApp();
  const { data, isLoading } = useApi<any[]>("/v1/graphql-services");
  const services = (data || []).filter((s) => s.environment === env);
  const [key, setKey] = useState("");
  const svc = services.find((s) => s.slug === key) || services[0];
  const [client, setClient] = useState("");
  const [query, setQuery] = useState("");
  const [vars, setVars] = useState("{}");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (svc && !query) {
      const q = svc.fields.find((f: any) => f.root === "Query");
      if (q) setQuery(`query Example {\n  ${q.field}${q.field.startsWith("search") ? '(q: "a", limit: 5)' : ""} {\n    id\n  }\n}`);
    }
  }, [svc, query]);

  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="GraphQL Studio" description="One GraphQL service per project and environment, generated from deployed capabilities. Resolvers call the same operations and policies as REST." />
      {!svc ? (
        <div className="panel"><Empty icon={<Boxes className="h-6 w-6" />} title={`No GraphQL services in ${env}`}>
          Deploy a capability with a GraphQL interface to {env}, or switch environment in the top bar.</Empty></div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
          <div className="space-y-5 min-w-0">
            <Panel title="Service" actions={<Badge>{svc.environment}</Badge>}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Project"><Select value={svc.slug} onChange={setKey} options={services.map((s) => ({ value: s.slug, label: s.project }))} /></Field>
                <Field label="Endpoint"><input className="input font-mono text-xs" readOnly value={svc.endpoint} /></Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-2xs text-ink-3">
                <Badge>max depth {svc.max_depth}</Badge><Badge>aliases ≤ 15</Badge>
                <Badge tone={svc.introspection ? "neutral" : "warn"}>introspection {svc.introspection ? "on" : "off"}</Badge>
              </div>
            </Panel>
            <Panel title="Resolver mapping" bodyClass="p-0">
              <table className="tbl"><thead><tr><th>Field</th><th>Operation</th><th>Scopes</th></tr></thead>
                <tbody>{svc.fields.map((f: any) => (
                  <tr key={f.root + f.field}><td className="font-mono text-xs"><span className="text-ink-4">{f.root}.</span>{f.field}</td><td>{f.operation}</td><td className="font-mono text-2xs">{f.scopes.join(", ")}</td></tr>
                ))}</tbody></table>
            </Panel>
            <Panel title="Schema"><CodeView value={svc.sdl} language="graphql" height={380} /></Panel>
          </div>
          <div className="space-y-5 min-w-0">
            <Panel title="Query console" actions={<Link href="/security?tab=clients" className="text-xs text-signal-2 hover:underline">Manage clients</Link>}>
              <div className="space-y-3">
                <Field label="Call as API client"><ClientPicker value={client} onChange={setClient} /></Field>
                <CodeView value={query} onChange={setQuery} language="graphql" readOnly={false} height={200} />
                <Field label="Variables (JSON)"><textarea className="textarea font-mono text-xs" rows={2} value={vars} onChange={(e) => setVars(e.target.value)} /></Field>
                <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} disabled={!client} loading={busy} onClick={async () => {
                  setBusy(true);
                  try { setRes(await callAs(client, svc.endpoint, { method: "POST", json: { query, variables: JSON.parse(vars || "{}") } })); }
                  catch (e: any) { setRes({ status: 0, body: { error: e.message } }); } finally { setBusy(false); }
                }}>Run query</Button>
              </div>
            </Panel>
            {res && (
              <Panel title="Response" actions={<><Badge tone={res.body?.errors ? "warn" : "good"}>{res.status}</Badge><span className="text-2xs text-ink-4">{res.ms} ms</span></>}>
                <CodeBlock code={JSON.stringify(res.body, null, 2)} maxHeight={420} />
              </Panel>
            )}
          </div>
        </div>
      )}
    </>
  );
}
