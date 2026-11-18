"use client";

import clsx from "clsx";
import { Check, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Button, ErrorNote, Field, PageHeader, Panel, Select, TagInput, useToast } from "@/components/ui";
import { post, useApi } from "@/lib/api";

const STEPS = ["Type", "Connection", "Authentication", "Governance", "Test & discover"];

export default function NewConnector() {
  const router = useRouter();
  const toast = useToast();
  const { data: types } = useApi<any[]>("/v1/connectors/types");
  const { data: projects } = useApi<any[]>("/v1/projects");
  const [step, setStep] = useState(0);
  const [f, setF] = useState<any>({
    name: "", type: "postgresql", hosting: "private_network", host: "", port: 5432, database: "", username: "", password: "",
    auth_method: "password", tls_mode: "verify-full", base_url: "", environment: "development", tags: [], owner: "",
    classification: "internal", project_ids: [],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>();
  const [result, setResult] = useState<any>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const isApi = f.type === "rest_api" || f.type === "graphql_api";

  async function submit() {
    setBusy(true); setErr(undefined);
    try {
      const body = { ...f, port: f.port ? Number(f.port) : null, password: f.password || null };
      const c = await post("/v1/connectors", body);
      const test = await post(`/v1/connectors/${c.id}/test`);
      let discovered = null;
      if (test.ok && !isApi) { try { discovered = await post(`/v1/connectors/${c.id}/discover`); } catch { /* shown on detail page */ } }
      setResult({ c, test, discovered });
      setF((x: any) => ({ ...x, password: "" }));
      toast(test.ok ? "Connector registered and reachable" : "Connector registered, but the connection test failed", test.ok ? "good" : "bad");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const canNext = [
    !!f.type,
    !!f.name && (isApi ? !!f.base_url : f.type === "sqlite" ? !!f.database : !!f.host && !!f.database),
    true, true, true,
  ][step];

  return (
    <>
      <PageHeader title="New connector" description="Connection metadata is stored in the registry; credentials go straight to the vault and are never shown again." />
      <div className="grid grid-cols-[220px_1fr] gap-6 items-start">
        <ol className="space-y-1">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button onClick={() => i < step && setStep(i)} className={clsx("w-full flex items-center gap-2.5 h-9 px-2 rounded text-sm text-left",
                i === step ? "bg-white border border-line font-medium" : "text-ink-3")}>
                <span className={clsx("h-5 w-5 rounded-full text-2xs flex items-center justify-center", i < step ? "bg-signal text-white" : i === step ? "bg-ink text-white" : "bg-line-2 text-ink-3")}>
                  {i < step ? <Check className="h-3 w-3" /> : i + 1}
                </span>{s}
              </button>
            </li>
          ))}
        </ol>
        <Panel>
          {step === 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {(types || []).map((t) => (
                <button key={t.type} disabled={t.status !== "supported"} onClick={() => { set("type", t.type); if (t.default_port) set("port", t.default_port); if (t.type === "sqlite") set("hosting", "local_development"); }}
                  className={clsx("text-left p-3 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                    f.type === t.type ? "border-signal ring-2 ring-signal/15" : "border-line hover:border-ink-4")}>
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="mt-1 flex gap-1.5"><Badge>{t.category}</Badge>{t.status === "planned" && <Badge tone="warn">planned</Badge>}</div>
                </button>
              ))}
            </div>
          )}
          {step === 1 && (
            <div className="grid grid-cols-2 gap-4 max-w-2xl">
              <div className="col-span-2"><Field label="Name"><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Customer database (prod replica)" /></Field></div>
              {isApi ? (
                <div className="col-span-2"><Field label="Base URL" hint="HTTPS required outside local development"><input className="input" value={f.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="https://api.example.com" /></Field></div>
              ) : f.type === "sqlite" ? (
                <div className="col-span-2"><Field label="Database file path" hint="Local development only"><input className="input font-mono text-xs" value={f.database} onChange={(e) => set("database", e.target.value)} /></Field></div>
              ) : (<>
                <Field label="Hosting">
                  <Select value={f.hosting} onChange={(v) => set("hosting", v)} options={[
                    { value: "private_network", label: "Private network" }, { value: "customer_cloud", label: "Customer cloud" },
                    { value: "public_endpoint", label: "Public endpoint (strict controls)" }, { value: "local_development", label: "Local development" }]} />
                </Field>
                <Field label="Environment"><Select value={f.environment} onChange={(v) => set("environment", v)} options={["development", "staging", "production"].map((e) => ({ value: e, label: e }))} /></Field>
                <Field label="Host"><input className="input" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="db.internal.example.com" /></Field>
                <Field label="Port"><input className="input" type="number" value={f.port} onChange={(e) => set("port", e.target.value)} /></Field>
                <Field label="Database"><input className="input" value={f.database} onChange={(e) => set("database", e.target.value)} /></Field>
                <Field label="TLS" hint={f.tls_mode === "disable" ? "Allowed only for local development" : "Server certificates are verified; no silent fallback"}>
                  <Select value={f.tls_mode} onChange={(v) => set("tls_mode", v)} options={[
                    { value: "verify-full", label: "Verify full (recommended)" }, { value: "verify-ca", label: "Verify CA" },
                    { value: "require", label: "Require (no verification)" }, { value: "disable", label: "Disable" }]} />
                </Field>
              </>)}
            </div>
          )}
          {step === 2 && (
            <div className="grid grid-cols-2 gap-4 max-w-2xl">
              <Field label="Method">
                <Select value={f.auth_method} onChange={(v) => set("auth_method", v)} options={[
                  { value: "password", label: "Username & password (vault)" }, { value: "tls_cert", label: "TLS client certificate" },
                  { value: "mtls", label: "Mutual TLS" }, { value: "cloud_iam", label: "Cloud IAM / workload identity" },
                  { value: "managed_identity", label: "Managed identity" }, { value: "none", label: "None" }]} />
              </Field>
              {!isApi && <Field label="Username"><input className="input" value={f.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" /></Field>}
              <div className="col-span-2">
                <Field label={isApi ? "Bearer token" : "Password"} hint="Write-only. Stored in the vault; the registry keeps only a reference.">
                  <div className="relative">
                    <Lock className="h-3.5 w-3.5 absolute left-3 top-3 text-ink-4" />
                    <input className="input pl-8" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />
                  </div>
                </Field>
              </div>
              <p className="col-span-2 text-xs text-ink-3">Use a dedicated least-privilege database principal for each connector. Write, DDL and administrative permissions are enabled separately after registration.</p>
            </div>
          )}
          {step === 3 && (
            <div className="grid grid-cols-2 gap-4 max-w-2xl">
              <Field label="Owner"><input className="input" value={f.owner} onChange={(e) => set("owner", e.target.value)} placeholder="Customer Platform team" /></Field>
              <Field label="Default classification"><Select value={f.classification} onChange={(v) => set("classification", v)} options={["public", "internal", "confidential", "restricted"].map((c) => ({ value: c, label: c }))} /></Field>
              <div className="col-span-2"><Field label="Tags"><TagInput value={f.tags} onChange={(v) => set("tags", v)} placeholder="domain:customer, region:au" /></Field></div>
              <div className="col-span-2">
                <Field label="Available to projects" hint="Empty means every project in the organisation">
                  <div className="flex flex-wrap gap-2">
                    {(projects || []).map((p) => {
                      const on = f.project_ids.includes(p.id);
                      return <button key={p.id} type="button" onClick={() => set("project_ids", on ? f.project_ids.filter((x: string) => x !== p.id) : [...f.project_ids, p.id])}
                        className={clsx("h-7 px-2.5 rounded border text-xs", on ? "border-signal bg-signal-soft text-signal-2" : "border-line")}>{p.name}</button>;
                    })}
                  </div>
                </Field>
              </div>
              <div className="col-span-2 rounded bg-paper p-3 text-xs text-ink-3">The connector is registered <b className="text-ink">read-only</b>. Grant write access from the connector page when an approved use case needs it.</div>
            </div>
          )}
          {step === 4 && (
            <div className="max-w-2xl space-y-4">
              {!result ? (
                <>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <dt className="text-ink-3">Name</dt><dd>{f.name}</dd>
                    <dt className="text-ink-3">Type</dt><dd>{types?.find((t) => t.type === f.type)?.label}</dd>
                    <dt className="text-ink-3">Target</dt><dd className="font-mono text-xs">{isApi ? f.base_url : f.type === "sqlite" ? f.database : `${f.host}:${f.port}/${f.database}`}</dd>
                    <dt className="text-ink-3">Credential</dt><dd>{f.password ? "Will be stored in vault" : "None"}</dd>
                  </dl>
                  <Button variant="primary" loading={busy} onClick={submit}>Register, test and discover</Button>
                  <ErrorNote error={err} />
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    {(result.test.checks || []).map((c: any) => (
                      <div key={c.name} className="flex items-center gap-2 text-sm">{c.ok ? <Check className="h-4 w-4 text-signal" /> : <span className="h-4 w-4 text-danger">✕</span>}{c.name}{c.detail && <span className="text-2xs text-ink-4">{c.detail}</span>}</div>
                    ))}
                    <div className={clsx("text-sm font-medium", result.test.ok ? "text-signal-2" : "text-danger")}>
                      {result.test.ok ? `Connected in ${result.test.latency_ms} ms` : `Connection failed: ${result.test.error}`}
                    </div>
                    {result.discovered && <div className="text-sm">Discovered {result.discovered.schema.schemas.reduce((n: number, s: any) => n + s.tables.length, 0)} table(s). Review classifications before building APIs.</div>}
                  </div>
                  <Button variant="primary" onClick={() => router.push(`/connectors/${result.c.id}`)}>Open connector</Button>
                </>
              )}
            </div>
          )}
          {step < 4 && (
            <div className="mt-6 pt-4 border-t border-line flex justify-between">
              <Button onClick={() => (step ? setStep(step - 1) : router.push("/connectors"))}>{step ? "Back" : "Cancel"}</Button>
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</Button>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
