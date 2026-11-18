"use client";

import { Check, Cpu, Lock, Plus, X } from "lucide-react";
import { useState } from "react";

import { Badge, Button, Empty, ErrorNote, Field, Modal, PageHeader, Panel, Select, Spinner, StatusDot, Toggle, useToast } from "@/components/ui";
import { del, patch, post, useApi } from "@/lib/api";

export default function Providers() {
  const { data, mutate, isLoading } = useApi<any[]>("/v1/model-providers");
  const { data: presets } = useApi<any[]>("/v1/model-providers/presets");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState("");
  const [results, setResults] = useState<Record<string, any>>({});

  return (
    <>
      <PageHeader title="Model providers" description="Register model endpoints for the assistant and the agent team. Keys go to the vault and are never shown again. Capabilities are recorded from tests, not assumed from the URL."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Add provider</Button>} />
      {isLoading ? <Spinner /> : !data?.length ? <div className="panel"><Empty icon={<Cpu className="h-6 w-6" />} title="No providers" /></div> : (
        <div className="space-y-4">
          {data.map((p) => (
            <Panel key={p.id} title={<span className="flex items-center gap-2">{p.name}{p.is_default && <Badge tone="good">default</Badge>}</span>}
              actions={<>
                {p.provider_type !== "builtin" && !p.is_default && <Button size="sm" onClick={async () => { await patch(`/v1/model-providers/${p.id}`, { is_default: true }); toast(`${p.name} is now the default`); mutate(); }}>Make default</Button>}
                {p.is_default && <Button size="sm" variant="ghost" onClick={async () => { await patch(`/v1/model-providers/${p.id}`, { is_default: false }); toast("Default cleared — using built-in engine"); mutate(); }}>Clear default</Button>}
                <Button size="sm" loading={testing === p.id} onClick={async () => {
                  setTesting(p.id);
                  try { const r = await post(`/v1/model-providers/${p.id}/test`); setResults({ ...results, [p.id]: r }); toast(r.ok ? "Provider responded" : "Provider test failed", r.ok ? "good" : "bad"); mutate(); }
                  finally { setTesting(""); }
                }}>Test</Button>
                {p.provider_type !== "builtin" && <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Remove ${p.name}?`)) { await del(`/v1/model-providers/${p.id}`); mutate(); } }}>Remove</Button>}
              </>}>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-5">
                <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Type</dt><dd>{p.provider_type}</dd>
                  {p.provider_type !== "builtin" && <><dt className="text-ink-3">Model</dt><dd className="font-mono text-xs">{p.model}</dd>
                    <dt className="text-ink-3">Endpoint</dt><dd className="font-mono text-2xs break-all">{p.base_url || "provider default"}</dd>
                    <dt className="text-ink-3">API key</dt><dd className="inline-flex items-center gap-1 text-xs">{p.has_key ? <><Lock className="h-3 w-3" /> stored in vault</> : "none"}</dd></>}
                  <dt className="text-ink-3">Max data class</dt><dd><Badge tone={p.data_classification_max === "restricted" ? "bad" : p.data_classification_max === "confidential" ? "warn" : "neutral"}>{p.data_classification_max}</Badge></dd>
                  <dt className="text-ink-3">Health</dt><dd className="inline-flex items-center gap-1.5 text-xs"><StatusDot tone={p.health === "healthy" ? "good" : p.health === "failing" ? "bad" : "neutral"} />{p.health}</dd>
                </dl>
                <div>
                  <div className="label mb-1.5">Tested capabilities</div>
                  <div className="flex flex-wrap gap-1">{(p.tested_capabilities || []).length ? p.tested_capabilities.map((c: string) => <Badge key={c} tone="good">{c}</Badge>) : <span className="text-xs text-ink-4">Run a test to record capabilities</span>}</div>
                  {(results[p.id] || p.last_test)?.checks && (
                    <ul className="mt-3 space-y-1 text-xs">{(results[p.id] || p.last_test).checks.map((c: any) => (
                      <li key={c.name} className="flex items-start gap-1.5">{c.ok ? <Check className="h-3.5 w-3.5 text-signal mt-0.5" /> : <X className="h-3.5 w-3.5 text-danger mt-0.5" />}
                        <span>{c.name}{c.detail && <span className="text-ink-4"> — {c.detail}</span>}</span></li>
                    ))}</ul>
                  )}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
      <AddProvider open={open} presets={presets || []} onClose={() => setOpen(false)} onCreated={() => { mutate(); toast("Provider added. Test it, then make it the default."); }} />
    </>
  );
}

function AddProvider({ open, onClose, presets, onCreated }: { open: boolean; onClose: () => void; presets: any[]; onCreated: () => void }) {
  const [f, setF] = useState<any>({ name: "", provider_type: "anthropic", base_url: "https://api.anthropic.com", model: "", api_key: "", data_classification_max: "internal", is_default: true, max_tokens: 2048, timeout_s: 60 });
  const [err, setErr] = useState<any>();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const preset = presets.find((p) => p.provider_type === f.provider_type);
  return (
    <Modal open={open} onClose={onClose} title="Add model provider" width={600}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name || !f.model} onClick={async () => {
        try { await post("/v1/model-providers", { ...f, api_key: f.api_key || null }); onCreated(); onClose(); setF({ ...f, name: "", api_key: "" }); } catch (e) { setErr(e); }
      }}>Add provider</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider type"><Select value={f.provider_type} onChange={(v) => { const p = presets.find((x) => x.provider_type === v); set("provider_type", v); set("base_url", p?.base_url || ""); }}
          options={presets.map((p) => ({ value: p.provider_type, label: p.label }))} /></Field>
        <Field label="Display name"><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={preset?.label} /></Field>
        <div className="col-span-2"><Field label="Base URL" hint="Custom endpoints are subject to the egress allowlist and TLS verification."><input className="input font-mono text-xs" value={f.base_url} onChange={(e) => set("base_url", e.target.value)} /></Field></div>
        <Field label="Model ID"><input className="input font-mono text-xs" value={f.model} onChange={(e) => set("model", e.target.value)} placeholder={preset?.model_hint} /></Field>
        <Field label="Highest data classification allowed" hint="Restricted data is never sent to providers below this level.">
          <Select value={f.data_classification_max} onChange={(v) => set("data_classification_max", v)} options={["public", "internal", "confidential", "restricted"].map((c) => ({ value: c, label: c }))} />
        </Field>
        <div className="col-span-2"><Field label="API key" hint="Write-only. Leave empty for local endpoints such as Ollama.">
          <input className="input" type="password" value={f.api_key} onChange={(e) => set("api_key", e.target.value)} autoComplete="new-password" /></Field></div>
        <Field label="Max tokens"><input type="number" className="input" value={f.max_tokens} onChange={(e) => set("max_tokens", Number(e.target.value))} /></Field>
        <Field label="Timeout (s)"><input type="number" className="input" value={f.timeout_s} onChange={(e) => set("timeout_s", Number(e.target.value))} /></Field>
        <div className="col-span-2"><Toggle checked={f.is_default} onChange={(v) => set("is_default", v)} label="Use as the default for the assistant and agents" /></div>
        <div className="col-span-2"><ErrorNote error={err} /></div>
      </div>
    </Modal>
  );
}
