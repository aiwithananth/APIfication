"use client";

import clsx from "clsx";
import { KeyRound, Plus, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Badge, Button, CopyButton, Empty, ErrorNote, Field, Modal, PageHeader, Panel, Select, Spinner, statusTone, TagInput, Tabs, Toggle, useToast } from "@/components/ui";
import { del, patch, post, timeAgo, useApi } from "@/lib/api";

type Tab = "clients" | "roles" | "policies" | "tags" | "simulator";

function Security() {
  const sp = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>((sp.get("tab") as Tab) || "clients");
  return (
    <>
      <PageHeader title="Security & Policies" description="Roles say who a caller acts as, scopes say which operations a token may request, tags classify resources. Policies combine them and fail closed." />
      <Tabs value={tab} onChange={(t) => { setTab(t); router.replace(`/security?tab=${t}`); }} className="mb-5" tabs={[
        { id: "clients", label: "API clients" }, { id: "roles", label: "Roles & scopes" }, { id: "policies", label: "Policies" },
        { id: "tags", label: "Tags" }, { id: "simulator", label: "Policy simulator" },
      ]} />
      {tab === "clients" && <Clients />}
      {tab === "roles" && <Roles />}
      {tab === "policies" && <Policies />}
      {tab === "tags" && <Tags />}
      {tab === "simulator" && <Simulator />}
    </>
  );
}

function Clients() {
  const { data, mutate, isLoading } = useApi<any[]>("/v1/api-clients");
  const { data: cat } = useApi<any>("/v1/security/catalogue");
  const { data: projects } = useApi<any[]>("/v1/projects");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  if (isLoading) return <Spinner />;
  return (
    <>
      <Panel title="API clients" bodyClass="p-0" actions={<Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>New client</Button>}
        description="Identities that call published APIs and MCP servers. Tokens are shown once and stored only as hashes. Tenant always comes from here, never from requests.">
        {!data?.length ? <Empty title="No API clients" /> : (
          <table className="tbl"><thead><tr><th>Client</th><th>Kind</th><th>Roles</th><th>Scopes</th><th>Tenant</th><th>Environments</th><th>Token</th><th></th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id}>
                <td><div className="font-medium">{c.name}</div><div className="text-2xs text-ink-4 font-mono">{c.subject}</div></td>
                <td><Badge tone={c.kind === "mcp_client" ? "mcp" : "neutral"}>{c.kind}</Badge></td>
                <td className="text-xs">{c.roles.join(", ")}</td>
                <td className="text-2xs font-mono max-w-[28ch]">{c.scopes.join(", ")}</td>
                <td className="text-xs">{c.tenant || "—"}</td>
                <td className="text-2xs">{c.environments.join(", ")}</td>
                <td className="text-2xs font-mono text-ink-4">{c.token_prefix}…</td>
                <td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" icon={<RotateCw className="h-3 w-3" />} onClick={async () => {
                    const r = await post(`/v1/api-clients/${c.id}/rotate`); setToken({ name: c.name, token: r.token }); mutate();
                  }}>Rotate</Button>
                  <Button size="sm" variant="ghost" onClick={async () => {
                    await patch(`/v1/api-clients/${c.id}`, { status: c.status === "active" ? "disabled" : "active" }); toast(c.status === "active" ? "Client disabled" : "Client enabled"); mutate();
                  }}>{c.status === "active" ? "Disable" : <span className="text-signal-2">Enable</span>}</Button>
                </td>
              </tr>
            ))}</tbody></table>
        )}
      </Panel>
      <NewClient open={open} onClose={() => setOpen(false)} roles={(cat?.roles || []).map((r: any) => r.name)} scopes={(cat?.scopes || []).map((s: any) => s.name)}
        projects={projects || []} onCreated={(r) => { setToken({ name: r.client.name, token: r.token }); mutate(); }} />
      <Modal open={!!token} onClose={() => setToken(null)} title="Copy this token now" footer={<Button variant="primary" onClick={() => setToken(null)}>I&apos;ve stored it</Button>}>
        <p className="text-sm text-ink-3 mb-3">This is the only time the token for <b className="text-ink">{token?.name}</b> is shown. Store it in your secret manager.</p>
        <div className="flex items-center gap-2 rounded bg-ink text-white px-3 py-2"><KeyRound className="h-4 w-4 text-white/60" /><code className="text-xs break-all flex-1">{token?.token}</code><CopyButton text={token?.token || ""} /></div>
      </Modal>
    </>
  );
}

function NewClient({ open, onClose, roles, scopes, projects, onCreated }: { open: boolean; onClose: () => void; roles: string[]; scopes: string[]; projects: any[]; onCreated: (r: any) => void }) {
  const [f, setF] = useState<any>({ name: "", kind: "application", subject: "", roles: [], scopes: [], tenant: "", environments: ["development"], project_ids: [] });
  const [err, setErr] = useState<any>();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  return (
    <Modal open={open} onClose={onClose} title="New API client" width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name} onClick={async () => {
        try { const r = await post("/v1/api-clients", { ...f, tenant: f.tenant || null }); onCreated(r); onClose(); } catch (e) { setErr(e); }
      }}>Create and issue token</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(v) => set("kind", v)} options={[{ value: "application", label: "Application" }, { value: "agent", label: "AI agent" }, { value: "mcp_client", label: "MCP client" }, { value: "service", label: "Service" }]} /></Field>
        <Field label="Subject" hint="Identity used for relationship checks, e.g. agent.lee"><input className="input" value={f.subject} onChange={(e) => set("subject", e.target.value)} /></Field>
        <Field label="Tenant" hint="Required to read tenant-scoped data"><input className="input" value={f.tenant} onChange={(e) => set("tenant", e.target.value)} placeholder="tenant-acme" /></Field>
        <div className="col-span-2"><Field label="Roles"><TagInput value={f.roles} onChange={(v) => set("roles", v)} suggestions={roles} /></Field></div>
        <div className="col-span-2"><Field label="Scopes" hint="Narrow, action-oriented. Wildcards are refused for production."><TagInput value={f.scopes} onChange={(v) => set("scopes", v)} suggestions={scopes} /></Field></div>
        <div className="col-span-2"><Field label="Environments">
          <div className="flex gap-2">{["development", "staging", "production"].map((e) => {
            const on = f.environments.includes(e);
            return <button key={e} type="button" onClick={() => set("environments", on ? f.environments.filter((x: string) => x !== e) : [...f.environments, e])}
              className={clsx("h-7 px-2.5 rounded border text-xs", on ? "border-signal bg-signal-soft text-signal-2" : "border-line")}>{e}</button>;
          })}</div></Field></div>
        <div className="col-span-2"><Field label="Projects" hint="Empty means all projects">
          <div className="flex flex-wrap gap-2">{projects.map((p) => {
            const on = f.project_ids.includes(p.id);
            return <button key={p.id} type="button" onClick={() => set("project_ids", on ? f.project_ids.filter((x: string) => x !== p.id) : [...f.project_ids, p.id])}
              className={clsx("h-7 px-2.5 rounded border text-xs", on ? "border-signal bg-signal-soft text-signal-2" : "border-line")}>{p.name}</button>;
          })}</div></Field></div>
        <div className="col-span-2"><ErrorNote error={err} /></div>
      </div>
    </Modal>
  );
}

function Roles() {
  const { data } = useApi<any>("/v1/security/catalogue");
  if (!data) return <Spinner />;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <Panel title="Roles" bodyClass="p-0" description="Collected from every capability's role matrix.">
        <table className="tbl"><thead><tr><th>Role</th><th>Scopes</th><th>Used by</th></tr></thead>
          <tbody>{data.roles.map((r: any) => (
            <tr key={r.name}><td className="font-mono text-xs">{r.name}</td><td className="text-2xs font-mono">{r.scopes.join(", ")}</td><td className="text-xs text-ink-3">{r.capabilities.join(", ")}</td></tr>
          ))}</tbody></table>
      </Panel>
      <Panel title="Scopes" bodyClass="p-0">
        <table className="tbl"><thead><tr><th>Scope</th><th>Grants</th></tr></thead>
          <tbody>{data.scopes.map((s: any) => (
            <tr key={s.name}><td><code className="text-xs">{s.name}</code><div className="text-2xs text-ink-4">{s.description}</div></td>
              <td className="text-xs">{s.operations.map((o: any, i: number) => <div key={i}>{o.operation} <span className="text-ink-4">· {o.capability}</span>{o.side_effect !== "read" && <Badge tone="warn" className="ml-1">{o.side_effect}</Badge>}</div>)}
                {!s.operations.length && <span className="text-ink-4">masking unlock only</span>}</td></tr>
          ))}</tbody></table>
      </Panel>
      <Panel title="Platform roles (who can change the platform)" className="xl:col-span-2">
        <div className="flex flex-wrap gap-2 text-xs">
          {["Platform Owner", "Organisation Administrator", "Security Administrator", "Project Administrator", "API Designer", "Developer", "Publisher / Release Approver", "Operator", "Auditor", "Read-only Consumer"].map((r) => <Badge key={r}>{r}</Badge>)}
        </div>
        <p className="mt-3 text-xs text-ink-3">In development mode you are signed in as a local admin with all platform roles. Connect your identity provider (OIDC/SAML) in <Link href="/settings/identity" className="underline">Settings → Identity</Link>.</p>
      </Panel>
    </div>
  );
}

function Policies() {
  const { data } = useApi<any>("/v1/security/catalogue");
  if (!data) return <Spinner />;
  return (
    <Panel bodyClass="p-0" description="Every operation has exactly one policy. Edit policies on the capability's Access & policies tab; each change creates a new revision.">
      <table className="tbl"><thead><tr><th>Policy</th><th>Capability</th><th>Roles</th><th>Scopes</th><th>Row filters</th><th>Version</th></tr></thead>
        <tbody>{data.policies.map((p: any) => (
          <tr key={p.capability_id + p.id}>
            <td><div className="font-medium">{p.name}</div><div className="text-2xs text-ink-4 font-mono">{p.id}</div></td>
            <td><Link href={`/capabilities/${p.capability_id}?tab=access`} className="hover:underline">{p.capability}</Link> <span className="text-2xs text-ink-4">r{p.revision}</span></td>
            <td className="text-xs">{p.roles.join(", ") || <span className="text-warn">any</span>}</td>
            <td className="text-2xs font-mono">{p.scopes.join(", ")}</td>
            <td className="text-2xs font-mono">{p.row_filters.map((r: any) => `${r.when_role}: ${r.field}=${r.equals}`).join("; ") || "—"}</td>
            <td className="text-xs">v{p.version}</td>
          </tr>
        ))}</tbody></table>
    </Panel>
  );
}

function Tags() {
  const { data, mutate } = useApi<any[]>("/v1/tags");
  const [f, setF] = useState({ key: "", value: "", description: "", security_sensitive: false });
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
      <Panel title="Tags" className="xl:col-span-2" bodyClass="p-0" description="Tags are labels, not permissions. Security-sensitive tags can only be assigned through governance.">
        <table className="tbl"><thead><tr><th>Tag</th><th>Description</th><th>Sensitive</th><th></th></tr></thead>
          <tbody>{(data || []).map((t) => (
            <tr key={t.id}><td><code className="text-xs">{t.name}</code></td><td className="text-ink-3">{t.description}</td>
              <td>{t.security_sensitive ? <Badge tone="warn">governed</Badge> : "—"}</td>
              <td className="text-right"><Button size="sm" variant="ghost" onClick={async () => { await del(`/v1/tags/${t.id}`); mutate(); }}>Remove</Button></td></tr>
          ))}</tbody></table>
      </Panel>
      <Panel title="New tag">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Key"><input className="input" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="region" /></Field>
            <Field label="Value"><input className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="au" /></Field>
          </div>
          <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Toggle checked={f.security_sensitive} onChange={(v) => setF({ ...f, security_sensitive: v })} label="Security-sensitive" />
          <Button variant="primary" disabled={!f.key || !f.value} onClick={async () => { await post("/v1/tags", f); setF({ key: "", value: "", description: "", security_sensitive: false }); mutate(); }}>Add tag</Button>
        </div>
      </Panel>
    </div>
  );
}

function Simulator() {
  const { data: caps } = useApi<any[]>("/v1/capabilities");
  const [capId, setCapId] = useState("");
  const cid = capId || caps?.[0]?.id || "";
  const { data: cap } = useApi<any>(cid ? `/v1/capabilities/${cid}` : null);
  const spec = cap?.revision?.spec;
  const [s, setS] = useState<any>({ operation_id: "", roles: [], scopes: [], tenant: "tenant-acme", environment: "development" });
  const [res, setRes] = useState<any>(null);
  const opId = s.operation_id || spec?.operations[0]?.id || "";
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <Panel title="Request">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Capability"><Select value={cid} onChange={setCapId} options={(caps || []).map((c) => ({ value: c.id, label: c.name }))} /></Field>
            <Field label="Operation"><Select value={opId} onChange={(v) => setS({ ...s, operation_id: v })} options={(spec?.operations || []).map((o: any) => ({ value: o.id, label: o.name }))} /></Field>
          </div>
          <Field label="Roles"><TagInput value={s.roles} onChange={(v) => setS({ ...s, roles: v })} suggestions={(spec?.roles || []).map((r: any) => r.name)} /></Field>
          <Field label="Scopes"><TagInput value={s.scopes} onChange={(v) => setS({ ...s, scopes: v })} suggestions={(spec?.scopes || []).map((x: any) => x.name)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tenant"><input className="input" value={s.tenant} onChange={(e) => setS({ ...s, tenant: e.target.value })} /></Field>
            <Field label="Environment"><Select value={s.environment} onChange={(v) => setS({ ...s, environment: v })} options={["development", "staging", "production"].map((e) => ({ value: e, label: e }))} /></Field>
          </div>
          <Button variant="primary" disabled={!cid} onClick={async () => setRes(await post("/v1/policies/simulate", { capability_id: cid, ...s, operation_id: opId }))}>Simulate decision</Button>
        </div>
      </Panel>
      <Panel title="Decision">
        {!res ? <p className="text-sm text-ink-3">Run a simulation to see the decision, row filters and field visibility.</p> : (
          <div className="space-y-3">
            <div className="flex items-center gap-2"><Badge tone={statusTone(res.allow ? "allow" : "deny")}>{res.allow ? "Allow" : "Deny"}</Badge><span className="text-sm">{res.reason}</span></div>
            <div className="text-xs text-ink-3">Policy {res.policy_id} v{res.policy_version}{res.missing_scopes?.length ? ` · missing ${res.missing_scopes.join(", ")}` : ""}</div>
            {res.row_filters?.length > 0 && <div className="text-sm">Row filter: <code className="text-xs">{res.row_filters.map((f: any) => `${f.field} = ${f.equals}`).join(" AND ")}</code></div>}
            {res.tenant_filter && <div className="text-sm">Tenant filter: <code className="text-xs">tenant = {s.tenant || "(none — request would be refused)"}</code></div>}
            {res.approval_required && <div className="text-sm text-warn">Allowed calls are held for approval.</div>}
            {res.fields?.length > 0 && <div className="flex flex-wrap gap-1">{res.fields.map((f: any) => (
              <Badge key={f.field} tone={f.result === "visible" ? "neutral" : f.result === "masked" ? "warn" : "bad"}>{f.field}: {f.result}</Badge>))}</div>}
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function Page() {
  return <Suspense><Security /></Suspense>;
}
