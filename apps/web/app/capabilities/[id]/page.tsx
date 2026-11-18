"use client";

import clsx from "clsx";
import { FlaskConical, Play, Rocket, Save, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useApp, usePageContext } from "@/components/AppContext";
import { CodeView, DiffView, langFor } from "@/components/CodeView";
import { MethodTag, ProjectionStrip } from "@/components/ProjectionStrip";
import { AgentTimeline, FieldMap, NotesList, OperationsTable, RoleMatrix, ValidationList } from "@/components/SpecViews";
import { Badge, Button, Empty, Field, PageHeader, Panel, Select, Spinner, statusTone, TagInput, Tabs, Toggle, useToast } from "@/components/ui";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";
import { api, del, post, timeAgo, useApi } from "@/lib/api";

type Tab = "overview" | "workflow" | "access" | "data" | "interfaces" | "tests" | "code" | "revisions";

function CapabilityPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { env } = useApp();
  const { data: cap, mutate, isLoading } = useApi<any>(`/v1/capabilities/${id}`);
  const { data: catalogue } = useApi<any>("/v1/node-catalogue");
  const { data: providers } = useApi<any[]>("/v1/model-providers");
  const [tab, setTab] = useState<Tab>((sp.get("tab") as Tab) || "overview");
  const [draft, setDraft] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [opId, setOpId] = useState<string>("");
  const [busy, setBusy] = useState<string>("");

  const rev = cap?.revision;
  useEffect(() => {
    if (rev && !dirty) {
      setDraft(structuredClone(rev.spec));
      setValidation(rev.validation);
      if (!opId && rev.spec.operations[0]) setOpId(rev.spec.operations[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev?.id]);

  usePageContext({ capability_id: id, capability_name: cap?.name, project_id: cap?.project_id, tab, operation_id: opId,
    validation: validation?.summary }, [id, cap?.name, tab, opId, validation?.summary]);

  function change(next: any) {
    setDraft(next); setDirty(true);
  }
  async function validateDraft(spec = draft) {
    const v = await post("/v1/validate", { spec, environment: env });
    setValidation(v);
    return v;
  }
  async function saveRevision(summary = "Edited in Workflow Studio") {
    setBusy("save");
    try {
      const r = await post(`/v1/capabilities/${id}/revisions`, { spec: draft, summary, regenerate_tests: true });
      toast(`Saved revision ${r.number} · ${r.validation.summary}`, r.validation.valid ? "good" : "bad");
      setDirty(false); await mutate();
    } catch (e: any) { toast(e.message, "bad"); } finally { setBusy(""); }
  }
  async function deploy(environment: string) {
    setBusy("deploy-" + environment);
    try {
      const r = await post("/v1/deployments", { capability_id: id, environment });
      if (r.status === "pending_approval") toast("Release request created. An approver must approve it in Approvals.", "neutral");
      else toast(`Deployed revision ${r.revision_number} to ${environment}`);
      await mutate();
    } catch (e: any) { toast(e.message, "bad"); } finally { setBusy(""); }
  }
  async function runTests() {
    setBusy("tests");
    try {
      const r = await post(`/v1/capabilities/${id}/tests/run`);
      toast(`Tests ${r.status}: ${r.passed}/${r.total}`, r.status === "passed" ? "good" : "bad");
      router.push(`/capabilities/${id}?tab=tests`); setTab("tests"); mutateRuns();
    } catch (e: any) { toast(e.message, "bad"); } finally { setBusy(""); }
  }
  const { data: runs, mutate: mutateRuns } = useApi<any[]>(`/v1/test-runs?capability_id=${id}`);

  if (isLoading || !cap || !draft || !catalogue) return <Spinner />;
  const interfaces = Array.from(new Set(draft.operations.flatMap((o: any) => o.interfaces.filter((i: any) => i.enabled !== false).map((i: any) => i.kind)))) as string[];
  const live = (cap.deployments || []).filter((d: any) => d.status === "active");
  const op = draft.operations.find((o: any) => o.id === opId) || draft.operations[0];

  return (
    <>
      <PageHeader
        title={cap.name}
        description={<span className="line-clamp-2" title={draft.capability.description}>{draft.capability.description}</span>}
        meta={<>
          <ProjectionStrip interfaces={interfaces} />
          <Badge tone={statusTone(rev.status)}>r{rev.number} · {rev.status}</Badge>
          <Link href={`/projects/${cap.project_id}`} className="text-xs text-ink-3 hover:underline">{cap.project?.name}</Link>
          {live.map((d: any) => <Badge key={d.id} tone="good">live in {d.environment} (r{d.revision_number})</Badge>)}
          {dirty && <Badge tone="warn">Unsaved changes</Badge>}
        </>}
        actions={dirty ? <>
          <Button icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => { setDraft(structuredClone(rev.spec)); setDirty(false); setValidation(rev.validation); }}>Discard</Button>
          <Button icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => validateDraft()}>Validate</Button>
          <Button variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={busy === "save"} onClick={() => saveRevision()}>Save revision</Button>
        </> : <>
          <Button icon={<FlaskConical className="h-3.5 w-3.5" />} loading={busy === "tests"} onClick={runTests}>Run tests</Button>
          <Button variant="primary" icon={<Rocket className="h-3.5 w-3.5" />} loading={busy === "deploy-development"} onClick={() => deploy("development")}
            disabled={!rev.validation?.valid}>Deploy to development</Button>
        </>}
      />
      <Tabs value={tab} onChange={(t) => { setTab(t); router.replace(`/capabilities/${id}?tab=${t}`); }} className="mb-5" tabs={[
        { id: "overview", label: "Overview" },
        { id: "workflow", label: "Workflow" },
        { id: "access", label: "Access & policies" },
        { id: "data", label: "Data" },
        { id: "interfaces", label: "Interfaces" },
        { id: "tests", label: "Tests", count: draft.tests.length },
        { id: "code", label: "Generated code" },
        { id: "revisions", label: "Revisions" },
      ]} />

      {tab === "overview" && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="xl:col-span-2 space-y-5">
            <Panel title="Operations" bodyClass="p-0"><OperationsTable spec={draft} onSelect={(o) => { setOpId(o); setTab("workflow"); }} /></Panel>
            <Panel title="Validation"><ValidationList validation={validation} onPick={(i) => { if (i.operation_id) { setOpId(i.operation_id); setTab("workflow"); } }} /></Panel>
            {cap.agent_run && <Panel title="How this was generated"><AgentTimeline steps={cap.agent_run.steps} findings={cap.agent_run.findings} /></Panel>}
          </div>
          <div className="space-y-5">
            <Promotion cap={cap} rev={rev} runs={runs || []} busy={busy} onDeploy={deploy} />
            <Panel title="Assumptions & questions"><NotesList assumptions={draft.assumptions} questions={draft.questions} /></Panel>
            <Panel title="Danger zone">
              <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
                if (!confirm("Delete this capability? Deployed capabilities must be stopped first.")) return;
                try { await del(`/v1/capabilities/${id}`); toast("Capability deleted"); router.push("/capabilities"); } catch (e: any) { toast(e.message, "bad"); }
              }}>Delete capability</Button>
            </Panel>
          </div>
        </div>
      )}

      {tab === "workflow" && op && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-72"><Select value={op.id} onChange={setOpId} options={draft.operations.map((o: any) => ({ value: o.id, label: o.name }))} /></div>
            <OpMeta op={op} />
            <div className="ml-auto text-2xs text-ink-4">Runtime: {op.workflow.runtime_class} · {op.workflow.nodes.length} nodes · Delete key removes the selection</div>
          </div>
          <WorkflowCanvas
            workflow={op.workflow} catalogue={catalogue} spec={draft} providers={providers || []}
            issues={[...(validation?.errors || []), ...(validation?.warnings || [])].filter((i: any) => i.operation_id === op.id)}
            onChange={(wf) => change({ ...draft, operations: draft.operations.map((o: any) => o.id === op.id ? { ...o, workflow: wf } : o) })}
          />
          <Panel title="Validation" actions={<Button size="sm" onClick={() => validateDraft()}>Validate draft</Button>}>
            <ValidationList validation={validation} onPick={(i) => i.operation_id && setOpId(i.operation_id)} />
          </Panel>
        </div>
      )}

      {tab === "access" && <AccessTab spec={draft} onChange={change} capabilityId={id} />}
      {tab === "data" && <DataTab spec={draft} onChange={change} />}
      {tab === "interfaces" && <InterfacesTab id={id} spec={draft} op={op} onChange={change} project={cap.project} />}
      {tab === "tests" && <TestsTab spec={draft} runs={runs || []} onRun={runTests} busy={busy === "tests"} id={id} onRegen={async () => {
        await post(`/v1/capabilities/${id}/tests/generate`); toast("Regenerated tests as a new revision"); mutate();
      }} />}
      {tab === "code" && <CodeTab id={id} />}
      {tab === "revisions" && <RevisionsTab id={id} current={rev} />}
    </>
  );
}

function OpMeta({ op }: { op: any }) {
  const rest = op.interfaces.find((i: any) => i.kind === "rest");
  return (
    <div className="flex items-center gap-2 text-xs">
      {rest && <><MethodTag method={rest.method} /><span className="font-mono">{rest.path}</span></>}
      <Badge tone={op.side_effect === "read" ? "neutral" : "warn"}>{op.side_effect}</Badge>
      {op.required_scopes.map((s: string) => <Badge key={s} className="font-mono">{s}</Badge>)}
    </div>
  );
}

function Promotion({ cap, rev, runs, busy, onDeploy }: { cap: any; rev: any; runs: any[]; busy: string; onDeploy: (e: string) => void }) {
  const passed = runs.find((r) => r.revision_id === rev.id && r.status === "passed");
  const steps = [
    { env: "development", gate: "Validated revision", ok: !!rev.validation?.valid },
    { env: "staging", gate: "Passing test run for this revision", ok: !!passed },
    { env: "production", gate: "Approved release request", ok: !!passed },
  ];
  const live = Object.fromEntries((cap.deployments || []).filter((d: any) => d.status === "active").map((d: any) => [d.environment, d]));
  return (
    <Panel title="Promotion">
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.env} className="flex items-start gap-3">
            <span className={clsx("mt-0.5 h-5 w-5 rounded-full text-2xs font-semibold flex items-center justify-center",
              live[s.env] ? "bg-signal text-white" : "bg-paper text-ink-3 border border-line")}>{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium capitalize">{s.env}</div>
              <div className="text-2xs text-ink-4">{live[s.env] ? `Live: r${live[s.env].revision_number} · ${timeAgo(live[s.env].created_at)}` : s.gate}</div>
            </div>
            <Button size="sm" disabled={!s.ok} loading={busy === "deploy-" + s.env} onClick={() => onDeploy(s.env)}>
              {s.env === "production" ? "Request release" : live[s.env]?.revision_id === rev.id ? "Redeploy" : "Deploy"}
            </Button>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-2xs text-ink-4">Deployments always point at an immutable revision ({rev.digest.slice(0, 19)}…).</p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ access */
function AccessTab({ spec, onChange, capabilityId }: { spec: any; onChange: (s: any) => void; capabilityId: string }) {
  const [sim, setSim] = useState<any>({ operation_id: spec.operations[0]?.id, roles: [spec.roles[0]?.name].filter(Boolean), scopes: spec.roles[0]?.scopes || [] });
  const [res, setRes] = useState<any>(null);
  const scopes = spec.scopes.map((s: any) => s.name);
  const roles = spec.roles.map((r: any) => r.name);
  function setPolicy(pid: string, patch: any) {
    onChange({ ...spec, policies: spec.policies.map((p: any) => p.id === pid ? { ...p, ...patch, version: (p.version || 1) + 1 } : p) });
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
      <div className="xl:col-span-2 space-y-5">
        <Panel title="Who can do what" bodyClass="p-0"><RoleMatrix spec={spec} /></Panel>
        <Panel title="Policies" description="Policies are evaluated for every interface. Changes bump the policy version and are saved with the next revision." bodyClass="p-0">
          <div className="divide-y divide-line-2">
            {spec.policies.map((p: any) => (
              <div key={p.id} className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="md:col-span-2 flex items-center gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  <code className="text-2xs text-ink-4">{p.id} · v{p.version}</code>
                </div>
                <Field label="Roles (any of)"><TagInput value={p.roles} onChange={(v) => setPolicy(p.id, { roles: v })} suggestions={roles} /></Field>
                <Field label="Scopes (all of)"><TagInput value={p.scopes} onChange={(v) => setPolicy(p.id, { scopes: v })} suggestions={scopes} /></Field>
                {p.row_filters?.length > 0 && (
                  <div className="md:col-span-2 text-xs text-ink-3">
                    Row filters: {p.row_filters.map((rf: any, i: number) => <code key={i} className="mr-2">{rf.when_role ? `when ${rf.when_role}: ` : ""}{rf.field} = {rf.equals}</code>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="space-y-5">
        <Panel title="Policy simulator" description="Check a decision without calling the API. Uses the saved revision.">
          <div className="space-y-3">
            <Field label="Operation"><Select value={sim.operation_id} onChange={(v) => setSim({ ...sim, operation_id: v })} options={spec.operations.map((o: any) => ({ value: o.id, label: o.name }))} /></Field>
            <Field label="Roles"><TagInput value={sim.roles} onChange={(v) => setSim({ ...sim, roles: v })} suggestions={roles} /></Field>
            <Field label="Scopes"><TagInput value={sim.scopes} onChange={(v) => setSim({ ...sim, scopes: v })} suggestions={scopes} /></Field>
            <Button variant="primary" onClick={async () => setRes(await post("/v1/policies/simulate", { capability_id: capabilityId, ...sim }))}>Simulate</Button>
            {res && (
              <div className={clsx("rounded border p-3 text-sm", res.allow ? "border-signal/30 bg-signal-soft/50" : "border-danger/30 bg-danger-soft/60")}>
                <div className="font-semibold">{res.allow ? "Allowed" : "Denied"}</div>
                <div className="text-xs text-ink-2 mt-0.5">{res.reason}</div>
                {res.row_filters?.length > 0 && <div className="text-xs mt-1">Row filter: {res.row_filters.map((f: any) => `${f.field} = ${f.equals}`).join(", ")}</div>}
                {res.tenant_filter && <div className="text-xs mt-1">Tenant filter applied from identity.</div>}
                {res.approval_required && <div className="text-xs mt-1 text-warn">Requires approval before execution.</div>}
                {res.fields?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">{res.fields.map((f: any) => (
                    <Badge key={f.field} tone={f.result === "visible" ? "neutral" : f.result === "masked" ? "warn" : "bad"}>{f.field}: {f.result}</Badge>
                  ))}</div>
                )}
              </div>
            )}
          </div>
        </Panel>
        <Panel title="Scopes" bodyClass="p-0">
          <ul>{spec.scopes.map((s: any) => (
            <li key={s.name} className="px-4 py-2 border-b border-line-2 last:border-0"><code className="text-xs">{s.name}</code><div className="text-2xs text-ink-4">{s.description}</div></li>
          ))}</ul>
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ data */
function DataTab({ spec, onChange }: { spec: any; onChange: (s: any) => void }) {
  const ent = spec.entities[0];
  if (!ent) return <Empty title="No entities" />;
  const scopes = spec.scopes.map((s: any) => s.name);
  function setField(name: string, patch: any) {
    onChange({ ...spec, entities: spec.entities.map((e: any, i: number) => i === 0 ? { ...e, fields: e.fields.map((f: any) => f.name === name ? { ...f, ...patch } : f) } : e) });
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
      <Panel title={`${ent.name} → ${ent.resource}`} className="xl:col-span-2" bodyClass="p-0"
        description="Field rules apply to every interface. Hidden fields are never selected from the database.">
        <table className="tbl">
          <thead><tr><th>Field</th><th>Classification</th><th>Returned</th><th>Mask unless scope</th><th>Writable</th></tr></thead>
          <tbody>
            {ent.fields.map((f: any) => (
              <tr key={f.name}>
                <td className="font-mono text-xs">{f.name}<div className="text-2xs text-ink-4 font-sans">{f.type}</div></td>
                <td><Select className="h-8 text-xs" value={f.classification} onChange={(v) => setField(f.name, { classification: v })}
                  options={["public", "internal", "confidential", "restricted"].map((c) => ({ value: c, label: c }))} /></td>
                <td><Toggle checked={f.exposed} onChange={(v) => setField(f.name, { exposed: v, ...(v ? {} : { masked_unless_scope: null }) })} /></td>
                <td><Select className="h-8 text-xs" value={f.masked_unless_scope || ""} onChange={(v) => setField(f.name, { masked_unless_scope: v || null })}
                  placeholder="Not masked" options={scopes.map((s: string) => ({ value: s, label: s }))} /></td>
                <td><Toggle checked={f.writable} disabled={[ent.primary_key, ent.tenant_key].includes(f.name)} onChange={(v) => setField(f.name, { writable: v })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div className="space-y-5">
        <Panel title="Entity">
          <dl className="text-sm space-y-2">
            <Row k="Connector" v={<Link href={`/connectors/${ent.connector_ref}`} className="hover:underline font-mono text-xs">{ent.connector_ref}</Link>} />
            <Row k="Resource" v={<code className="text-xs">{ent.resource}</code>} />
            <Row k="Primary key" v={<code className="text-xs">{ent.primary_key}</code>} />
            <Row k="Tenant key" v={ent.tenant_key ? <code className="text-xs">{ent.tenant_key}</code> : <span className="text-warn">none</span>} />
            <Row k="Owner key" v={ent.owner_key ? <code className="text-xs">{ent.owner_key}</code> : "—"} />
          </dl>
        </Panel>
        <Panel title="Read-only view"><FieldMap entity={ent} /></Panel>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd>{v}</dd></div>;
}

/* ------------------------------------------------------------------ interfaces */
function InterfacesTab({ id, spec, op, onChange, project }: { id: string; spec: any; op: any; onChange: (s: any) => void; project: any }) {
  const [view, setView] = useState<"matrix" | "openapi" | "graphql" | "mcp" | "rego">("matrix");
  const { data: proj } = useApi<any>(`/v1/capabilities/${id}/projections`);
  function toggle(opId: string, kind: string, on: boolean) {
    onChange({
      ...spec, operations: spec.operations.map((o: any) => {
        if (o.id !== opId) return o;
        const has = o.interfaces.find((i: any) => i.kind === kind);
        if (has) return { ...o, interfaces: o.interfaces.map((i: any) => i.kind === kind ? { ...i, enabled: on } : i) };
        if (!on) return o;
        const def = kind === "graphql" ? { kind, field: o.id.replace(/_(\w)/g, (_: any, c: string) => c.toUpperCase()), operation: o.side_effect === "read" ? "query" : "mutation" }
          : kind === "mcp" ? { kind, tool_name: o.id } : { kind, method: "GET", path: `/${o.id}` };
        return { ...o, interfaces: [...o.interfaces, def] };
      }),
    });
  }
  return (
    <div className="space-y-4">
      <Tabs value={view} onChange={setView} tabs={[
        { id: "matrix", label: "Exposure" }, { id: "openapi", label: "OpenAPI" }, { id: "graphql", label: "GraphQL SDL" },
        { id: "mcp", label: "MCP tools" }, { id: "rego", label: "OPA Rego" },
      ]} />
      {view === "matrix" && (
        <Panel bodyClass="p-0" description="Every interface calls the same operation and policy. Toggle exposure per operation; MCP write tools trigger a review warning.">
          <table className="tbl">
            <thead><tr><th>Operation</th><th className="text-center">REST</th><th className="text-center">GraphQL</th><th className="text-center">MCP</th><th>Names</th></tr></thead>
            <tbody>{spec.operations.map((o: any) => {
              const get = (k: string) => o.interfaces.find((i: any) => i.kind === k);
              return (
                <tr key={o.id}>
                  <td>{o.name} <Badge tone={o.side_effect === "read" ? "neutral" : "warn"} className="ml-1">{o.side_effect}</Badge></td>
                  {["rest", "graphql", "mcp"].map((k) => (
                    <td key={k} className="text-center"><Toggle checked={!!get(k) && get(k).enabled !== false} onChange={(v) => toggle(o.id, k, v)} /></td>
                  ))}
                  <td className="text-2xs font-mono text-ink-3 space-y-0.5">
                    {get("rest") && <div>{get("rest").method} {get("rest").path}</div>}
                    {get("graphql") && <div>{get("graphql").operation} {get("graphql").field}</div>}
                    {get("mcp") && <div>tool {get("mcp").tool_name}</div>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
          <div className="p-4 border-t border-line text-xs text-ink-3">
            Endpoints: <code>/gw/&lt;env&gt;/{project?.slug}/api</code> · <code>/gw/&lt;env&gt;/{project?.slug}/graphql</code> · MCP via servers in MCP Studio. Projections below reflect the saved revision.
          </div>
        </Panel>
      )}
      {view !== "matrix" && !proj && <Spinner />}
      {view === "openapi" && proj && <CodeView value={JSON.stringify(proj.openapi, null, 2)} language="json" height={560} />}
      {view === "graphql" && proj && <CodeView value={proj.graphql} language="graphql" height={560} />}
      {view === "mcp" && proj && <CodeView value={JSON.stringify(proj.mcp_tools, null, 2)} language="json" height={560} />}
      {view === "rego" && proj && <CodeView value={proj.rego} language="plaintext" height={560} />}
    </div>
  );
}

/* ------------------------------------------------------------------ tests */
function TestsTab({ spec, runs, onRun, busy, onRegen, id }: { spec: any; runs: any[]; onRun: () => void; busy: boolean; onRegen: () => void; id: string }) {
  const last = runs[0];
  const results = Object.fromEntries((last?.results || []).map((r: any) => [r.id, r]));
  const cats = Array.from(new Set(spec.tests.map((t: any) => t.category))) as string[];
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        {last && <Badge tone={statusTone(last.status)}>Last run r{last.revision_number}: {last.passed}/{last.total} · {timeAgo(last.created_at)}</Badge>}
        <div className="text-xs text-ink-3">{cats.map((c) => `${c} ${spec.tests.filter((t: any) => t.category === c).length}`).join(" · ")}</div>
        <div className="ml-auto flex gap-2">
          <Button onClick={onRegen}>Regenerate tests</Button>
          <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={busy} onClick={onRun}>Run tests</Button>
        </div>
      </div>
      <Panel bodyClass="p-0">
        <table className="tbl">
          <thead><tr><th>Test</th><th>Category</th><th>Caller</th><th>Expect</th><th>Result</th></tr></thead>
          <tbody>
            {spec.tests.map((t: any) => {
              const r = results[t.id];
              return (
                <tr key={t.id}>
                  <td><div>{t.name}</div><div className="text-2xs text-ink-4 font-mono">{t.id}</div></td>
                  <td><Badge>{t.category}</Badge></td>
                  <td className="text-2xs font-mono text-ink-3">{(t.principal.roles || []).join(",") || "—"} · {(t.principal.scopes || []).length} scope(s) · {t.principal.tenant}</td>
                  <td className="text-xs">{t.expect_status}{t.expect_max_rows !== null && t.expect_max_rows !== undefined ? ` · ≤${t.expect_max_rows} rows` : ""}
                    {t.expect_absent_fields?.length ? ` · hides ${t.expect_absent_fields.join(", ")}` : ""}</td>
                  <td>{r ? (r.passed ? <Badge tone="good">passed · {r.status}</Badge> : <span className="text-xs text-danger">{r.problems.join("; ")}</span>) : <span className="text-ink-4 text-xs">not run</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      <p className="text-2xs text-ink-4">Tests execute through the same runtime as the gateway, with synthetic identities. <Link className="underline" href={`/testing?capability=${id}`}>All runs</Link></p>
    </div>
  );
}

/* ------------------------------------------------------------------ code */
function CodeTab({ id }: { id: string }) {
  const { data } = useApi<any>(`/v1/capabilities/${id}/build`);
  const [file, setFile] = useState("service/main.py");
  if (!data) return <Spinner label="Compiling" />;
  const files = Object.keys(data.files).sort();
  return (
    <div className="grid grid-cols-[240px_1fr] gap-4">
      <Panel title="Build artefact" bodyClass="p-2">
        <ul className="space-y-0.5">{files.map((f) => (
          <li key={f}><button onClick={() => setFile(f)} className={clsx("w-full text-left px-2 h-7 rounded text-xs font-mono truncate", f === file ? "bg-signal-soft text-signal-2" : "hover:bg-paper")}>{f}</button></li>
        ))}</ul>
        <div className="mt-3 px-2 text-2xs text-ink-4 break-all">Digest {data.digest.slice(0, 23)}… · r{data.revision}</div>
      </Panel>
      <div>
        <div className="mb-2 text-xs text-ink-3">Generated, read-only. Edit the specification (canvas, data, policies) and save a revision to regenerate.</div>
        <CodeView value={data.files[file] || ""} language={langFor(file)} height={600} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ revisions */
function RevisionsTab({ id, current }: { id: string; current: any }) {
  const { data } = useApi<any[]>(`/v1/capabilities/${id}/revisions`);
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>(current.id);
  const [diff, setDiff] = useState<{ o: string; m: string } | null>(null);
  useEffect(() => { if (data && data.length > 1 && !a) setA(data[1].id); }, [data, a]);
  const opts = useMemo(() => (data || []).map((r) => ({ value: r.id, label: `r${r.number} · ${r.summary || ""}` })), [data]);
  if (!data) return <Spinner />;
  return (
    <div className="space-y-5">
      <Panel bodyClass="p-0">
        <table className="tbl">
          <thead><tr><th>Revision</th><th>Status</th><th>Summary</th><th>Validation</th><th>Author</th><th>Digest</th><th className="text-right">Created</th></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id}>
              <td className="font-medium">r{r.number}{r.id === current.id && <Badge className="ml-1.5">latest</Badge>}</td>
              <td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
              <td className="text-ink-2">{r.summary}</td>
              <td className="text-xs">{r.validation?.summary}</td>
              <td className="text-xs text-ink-3">{r.author}</td>
              <td className="font-mono text-2xs text-ink-4">{r.digest.slice(7, 19)}</td>
              <td className="text-right text-2xs text-ink-4">{timeAgo(r.created_at)}</td>
            </tr>
          ))}</tbody>
        </table>
      </Panel>
      {data.length > 1 && (
        <Panel title="Compare revisions">
          <div className="flex items-end gap-3 mb-3">
            <Field label="From"><Select value={a} onChange={setA} options={opts} /></Field>
            <Field label="To"><Select value={b} onChange={setB} options={opts} /></Field>
            <Button onClick={async () => {
              const [ra, rb] = await Promise.all([api(`/v1/capabilities/${id}/revisions/${a}`), api(`/v1/capabilities/${id}/revisions/${b}`)]);
              setDiff({ o: JSON.stringify(ra.spec, null, 2), m: JSON.stringify(rb.spec, null, 2) });
            }}>Show diff</Button>
          </div>
          {diff && <DiffView original={diff.o} modified={diff.m} />}
        </Panel>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><CapabilityPage /></Suspense>;
}
