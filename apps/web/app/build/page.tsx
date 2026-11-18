"use client";

import { Bot, Lightbulb, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { usePageContext } from "@/components/AppContext";
import { ProjectionStrip } from "@/components/ProjectionStrip";
import { AgentTimeline, FieldMap, NotesList, OperationsTable, RoleMatrix, ValidationList } from "@/components/SpecViews";
import { Badge, Button, ErrorNote, Field, PageHeader, Panel, Select, Tabs, Toggle, useToast } from "@/components/ui";
import { post, useApi } from "@/lib/api";

const EXAMPLES = [
  {
    label: "Customer service (REST, GraphQL, MCP)",
    text: "Create a customer service API using the Demo CRM database. Generate REST and GraphQL interfaces for customer search, customer detail retrieval and profile updates. Support agents can read assigned customers, managers can update permitted profile fields, and administrators can suspend accounts with approval. Do not expose payment-card data. Create an MCP server with read-only tools for the support assistant.",
  },
  { label: "Order lookup for analysts", text: "Create an orders API. Analysts can search orders and view order details. Expose REST and read-only MCP tools." },
  { label: "Support tickets", text: "Create a support ticket API with REST and GraphQL. Support agents can view their assigned tickets and close tickets with approval. Do not expose internal notes." },
];

function Builder() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data: projects } = useApi<any[]>("/v1/projects");
  const { data: connectors } = useApi<any[]>("/v1/connectors");
  const { data: providers } = useApi<any[]>("/v1/model-providers");
  const [projectId, setProjectId] = useState(params.get("project") || "");
  const [connectorId, setConnectorId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [useAgents, setUseAgents] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<any>();
  const [result, setResult] = useState<any>(null);
  const [tab, setTab] = useState<"ops" | "access" | "data" | "notes" | "agents">("ops");
  const llm = providers?.find((p) => p.is_default && p.provider_type !== "builtin");
  usePageContext({ project_id: projectId, builder_prompt: prompt.slice(0, 300) }, [projectId, prompt]);

  useEffect(() => { if (!projectId && projects?.length) setProjectId(projects[0].id); }, [projects, projectId]);
  useEffect(() => {
    if (!connectorId && connectors?.length) setConnectorId((connectors.find((c) => c.table_count > 0) || connectors[0]).id);
  }, [connectors, connectorId]);

  async function generate() {
    setBusy(true); setErr(undefined); setResult(null);
    try {
      const r = await post("/v1/capabilities/generate?save=false", { prompt, project_id: projectId, connector_id: connectorId || null, use_agents: useAgents });
      setResult(r); setTab("ops");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function save() {
    setSaving(true);
    try {
      const r = await post("/v1/capabilities", { spec: result.spec, project_id: projectId, prompt, connector_id: connectorId, agent_run_id: result.run?.id });
      toast(`Saved ${r.capability.name} as revision ${r.revision.number}`);
      router.push(`/capabilities/${r.capability.id}`);
    } catch (e: any) { toast(e.message, "bad"); } finally { setSaving(false); }
  }

  const spec = result?.spec;
  const conn = connectors?.find((c) => c.id === connectorId);
  return (
    <>
      <PageHeader title="API Builder" description="Describe a business capability in plain language. You get an editable specification with its APIs, workflow, policies and tests — nothing is published until you deploy it." />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-5 items-start">
        <Panel title="Describe the capability">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project">
              <Select value={projectId} onChange={setProjectId} options={(projects || []).map((p) => ({ value: p.id, label: p.name }))} />
            </Field>
            <Field label="Data source" hint={conn ? `${conn.table_count} table(s) discovered · ${conn.read_only ? "read-only" : "read/write"}` : undefined}>
              <Select value={connectorId} onChange={setConnectorId} options={(connectors || []).map((c) => ({ value: c.id, label: c.name }))} placeholder="None" />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Requirement">
              <textarea className="textarea font-normal leading-6" rows={9} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. Create a customer API. Support agents can read assigned customers; managers can update profile fields. Do not expose card numbers. Add read-only MCP tools."
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && prompt.trim()) generate(); }} />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map((x) => (
              <button key={x.label} onClick={() => setPrompt(x.text)} className="inline-flex items-center gap-1 text-xs px-2 h-7 rounded border border-line text-ink-2 hover:border-signal hover:text-signal-2">
                <Lightbulb className="h-3 w-3" /> {x.label}
              </button>
            ))}
          </div>
          <div className="mt-4 rounded bg-paper/70 border border-line-2 p-3 text-xs text-ink-3 space-y-1">
            <div>Good prompts name the <b className="text-ink-2">entity</b>, the <b className="text-ink-2">operations</b>, <b className="text-ink-2">who</b> may do each, <b className="text-ink-2">sensitive data</b> to keep out, and the <b className="text-ink-2">interfaces</b>.</div>
            <div>Defaults: new APIs are private, MCP tools are read-only, writes need explicit scopes, nothing reaches production without approval.</div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Toggle checked={useAgents} onChange={setUseAgents} label="Use the agent team" />
            <Button variant="primary" onClick={generate} loading={busy} disabled={!prompt.trim() || !projectId} icon={<Sparkles className="h-4 w-4" />}>
              Generate
            </Button>
          </div>
          <div className="mt-2 text-2xs text-ink-4 text-right">{llm ? `Planner: ${llm.name} (${llm.model}) + deterministic builder` : "Planner: built-in deterministic engine"} · ⌘↵</div>
          <div className="mt-3"><ErrorNote error={err} /></div>
        </Panel>

        <div className="min-w-0">
          {!result ? (
            <div className="panel p-8 text-center text-sm text-ink-3">
              <Bot className="h-6 w-6 mx-auto mb-2 text-ink-4" />
              The generated architecture appears here as editable objects: operations, interfaces, access matrix, data mapping and test plan.
            </div>
          ) : (
            <section className="panel">
              <header className="px-4 py-3 border-b border-line flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-lg font-semibold">{spec.capability.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <ProjectionStrip interfaces={Array.from(new Set(spec.operations.flatMap((o: any) => o.interfaces.map((i: any) => i.kind))))} />
                    <Badge>{spec.operations.length} operations</Badge>
                    <Badge>{spec.tests.length} tests</Badge>
                    <Badge tone={result.validation.valid ? "good" : "bad"}>{result.validation.valid ? "Valid" : result.validation.summary}</Badge>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button onClick={generate} loading={busy}>Regenerate</Button>
                  <Button variant="primary" onClick={save} loading={saving}>Save capability</Button>
                </div>
              </header>
              <Tabs className="px-2" value={tab} onChange={setTab} tabs={[
                { id: "ops", label: "Operations", count: spec.operations.length },
                { id: "access", label: "Access matrix" },
                { id: "data", label: "Data mapping" },
                { id: "notes", label: "Assumptions", count: spec.assumptions.length + spec.questions.length },
                { id: "agents", label: "Agent run" },
              ]} />
              <div className={tab === "ops" || tab === "data" || tab === "access" ? "" : "p-4"}>
                {tab === "ops" && <OperationsTable spec={spec} />}
                {tab === "access" && <div className="p-0"><RoleMatrix spec={spec} />
                  <div className="p-4 border-t border-line text-xs text-ink-3">Tenant isolation: {spec.entities[0]?.tenant_key ? <>every query is filtered by <code className="font-mono">{spec.entities[0].tenant_key}</code> from the caller&apos;s identity.</> : "no tenant column found."}</div></div>}
                {tab === "data" && spec.entities[0] && <FieldMap entity={spec.entities[0]} />}
                {tab === "notes" && <NotesList assumptions={spec.assumptions} questions={spec.questions} />}
                {tab === "agents" && (result.run ? <AgentTimeline steps={result.run.steps} findings={result.findings} /> : <p className="text-sm text-ink-3">Generated without the agent team.</p>)}
              </div>
              <footer className="border-t border-line p-4"><ValidationList validation={result.validation} /></footer>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export default function BuildPage() {
  return <Suspense><Builder /></Suspense>;
}
