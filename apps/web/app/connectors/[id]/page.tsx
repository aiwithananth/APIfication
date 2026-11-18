"use client";

import clsx from "clsx";
import { Check, Eye, RefreshCw, ScanSearch, Table2, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { usePageContext } from "@/components/AppContext";
import { Badge, Button, Empty, Field, Modal, PageHeader, Panel, Select, Spinner, StatusDot, Toggle, useToast } from "@/components/ui";
import { del, patch, post, put, timeAgo, useApi } from "@/lib/api";

export default function ConnectorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data: c, mutate, isLoading } = useApi<any>(`/v1/connectors/${id}`);
  const [table, setTable] = useState<string>("");
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [writeModal, setWriteModal] = useState(false);
  const [reason, setReason] = useState("");
  const [rotate, setRotate] = useState("");
  usePageContext({ connector_id: id, connector_name: c?.name, table }, [id, c?.name, table]);

  const tables = (c?.schema?.schemas || []).flatMap((s: any) => s.tables);
  useEffect(() => { if (!table && tables.length) setTable(tables[0].name); }, [tables, table]);
  if (isLoading || !c) return <Spinner />;
  const t = tables.find((x: any) => x.name === table);
  const fp = { ...(c.field_policies || {}), ...edits };

  async function act(name: string, fn: () => Promise<any>, ok: string) {
    setBusy(name);
    try { await fn(); toast(ok); await mutate(); } catch (e: any) { toast(e.message, "bad"); } finally { setBusy(""); }
  }
  const setFP = (key: string, patchV: any) => setEdits((e) => ({ ...e, [key]: { ...(fp[key] || {}), ...patchV } }));

  return (
    <>
      <PageHeader title={c.name}
        meta={<>
          <Badge>{c.type}</Badge><Badge>{c.environment}</Badge>
          {c.read_only ? <Badge>read-only</Badge> : <Badge tone="warn">read/write</Badge>}
          <span className="inline-flex items-center gap-1.5 text-xs"><StatusDot tone={c.health === "healthy" ? "good" : c.health === "failing" ? "bad" : "neutral"} />{c.health}</span>
          {c.has_secret && <Badge tone="good">credential in vault</Badge>}
        </>}
        actions={<>
          <Button icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === "test"} onClick={() => act("test", () => post(`/v1/connectors/${id}/test`), "Connection tested")}>Test connection</Button>
          <Button icon={<ScanSearch className="h-3.5 w-3.5" />} loading={busy === "discover"} onClick={() => act("discover", () => post(`/v1/connectors/${id}/discover`), "Schema discovered")}>Discover schema</Button>
        </>} />

      <div className="grid grid-cols-1 xl:grid-cols-[240px_1fr_300px] gap-5 items-start">
        <Panel title="Tables" bodyClass="p-2">
          {!tables.length ? <p className="text-sm text-ink-3 p-2">Run discovery to list tables.</p> : (
            <ul className="space-y-0.5">{tables.map((x: any) => (
              <li key={x.name}>
                <button onClick={() => { setTable(x.name); setPreview(null); }} className={clsx("w-full flex items-center gap-2 px-2 h-8 rounded text-sm text-left", x.name === table ? "bg-signal-soft text-signal-2" : "hover:bg-paper")}>
                  <Table2 className="h-3.5 w-3.5" /><span className="truncate font-mono text-xs">{x.name}</span><span className="ml-auto text-2xs text-ink-4">{x.columns.length}</span>
                </button>
              </li>
            ))}</ul>
          )}
        </Panel>

        <div className="space-y-5 min-w-0">
          <Panel title={t ? `${t.name} · classification` : "Columns"} bodyClass="p-0"
            description="Metadata discovery is not data permission. Classify columns here; generated capabilities inherit these rules."
            actions={t && <>
              <Button size="sm" icon={<Eye className="h-3.5 w-3.5" />} disabled={c.environment !== "development"} onClick={async () => {
                try { setPreview(await post(`/v1/connectors/${id}/preview`, { table })); } catch (e: any) { toast(e.message, "bad"); }
              }}>Masked preview</Button>
              <Button size="sm" variant="primary" disabled={!Object.keys(edits).length} loading={busy === "fp"}
                onClick={() => act("fp", async () => { await put(`/v1/connectors/${id}/field-policies`, edits); setEdits({}); }, "Classifications saved")}>Save</Button>
            </>}>
            {!t ? <Empty title="No table selected" /> : (
              <table className="tbl">
                <thead><tr><th>Column</th><th>Type</th><th>Classification</th><th>Exposable</th><th>Source</th></tr></thead>
                <tbody>{t.columns.map((col: any) => {
                  const key = `${t.name}.${col.name}`;
                  const p = fp[key] || {};
                  return (
                    <tr key={col.name} className={clsx(edits[key] && "bg-warn-soft/30")}>
                      <td className="font-mono text-xs">{col.name}{col.primary_key && <Badge className="ml-1.5">pk</Badge>}</td>
                      <td className="text-xs text-ink-3">{col.native_type}</td>
                      <td><Select className="h-8 text-xs w-36" value={p.classification || "internal"} onChange={(v) => setFP(key, { classification: v })}
                        options={["public", "internal", "confidential", "restricted"].map((x) => ({ value: x, label: x }))} /></td>
                      <td><Toggle checked={p.exposed !== false} onChange={(v) => setFP(key, { exposed: v })} /></td>
                      <td className="text-2xs text-ink-4">{p.source === "admin" ? "admin" : p.source === "suggested" ? <span title={col.suggestion?.reason}>suggested</span> : "—"}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </Panel>
          {preview && (
            <Panel title="Masked sample (development only)" bodyClass="p-0 overflow-x-auto">
              <table className="tbl"><thead><tr>{Object.keys(preview.rows[0] || {}).map((k) => <th key={k} className="font-mono">{k}</th>)}</tr></thead>
                <tbody>{preview.rows.map((r: any, i: number) => <tr key={i}>{Object.values(r).map((v: any, j) => <td key={j} className="text-xs whitespace-nowrap">{String(v ?? "")}</td>)}</tr>)}</tbody></table>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          <Panel title="Connection">
            <dl className="text-sm space-y-2">
              {c.type === "sqlite" ? <Item k="File" v={<span className="font-mono text-2xs break-all">{c.database}</span>} /> : c.base_url ? <Item k="Base URL" v={c.base_url} /> : <>
                <Item k="Host" v={c.host} /><Item k="Port" v={c.port} /><Item k="Database" v={c.database} /><Item k="User" v={c.username} /><Item k="TLS" v={c.tls_mode} />
              </>}
              <Item k="Hosting" v={c.hosting} />
              <Item k="Owner" v={c.owner || "—"} />
              <Item k="Last test" v={c.last_test ? (c.last_test.ok ? `ok · ${c.last_test.latency_ms} ms` : "failed") : "never"} />
            </dl>
            {c.last_test?.checks?.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">{c.last_test.checks.map((k: any) => (
                <li key={k.name} className="flex items-center gap-1.5">{k.ok ? <Check className="h-3.5 w-3.5 text-signal" /> : <span className="text-danger">✕</span>}{k.name}</li>
              ))}</ul>
            )}
          </Panel>
          <Panel title="Access">
            <div className="flex items-center justify-between">
              <div className="text-sm">{c.read_only ? "Read-only" : "Write enabled"}</div>
              <Button size="sm" variant={c.read_only ? "secondary" : "danger"} onClick={() => setWriteModal(true)}>{c.read_only ? "Grant write access" : "Revoke write access"}</Button>
            </div>
            <p className="mt-2 text-2xs text-ink-4">Changes are recorded in the audit log with your reason.</p>
          </Panel>
          {c.type !== "sqlite" && (
            <Panel title="Rotate credential">
              <div className="flex gap-2">
                <input type="password" className="input" value={rotate} onChange={(e) => setRotate(e.target.value)} placeholder="New secret" autoComplete="new-password" />
                <Button disabled={!rotate} onClick={() => act("rotate", async () => { await patch(`/v1/connectors/${id}`, { password: rotate }); setRotate(""); }, "Credential rotated")}>Rotate</Button>
              </div>
            </Panel>
          )}
          <Panel title="Danger zone">
            <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
              if (!confirm(`Delete connector ${c.name}?`)) return;
              try { await del(`/v1/connectors/${id}`); toast("Connector deleted"); router.push("/connectors"); } catch (e: any) { toast(e.message, "bad"); }
            }}>Delete connector</Button>
          </Panel>
          <p className="text-2xs text-ink-4">Updated {timeAgo(c.updated_at)}</p>
        </div>
      </div>

      <Modal open={writeModal} onClose={() => setWriteModal(false)} title={c.read_only ? "Grant write access" : "Revoke write access"}
        footer={<><Button onClick={() => setWriteModal(false)}>Cancel</Button>
          <Button variant={c.read_only ? "primary" : "danger"} disabled={c.read_only && !reason.trim()} onClick={() => act("rw", async () => {
            await patch(`/v1/connectors/${id}`, { read_only: !c.read_only, reason }); setWriteModal(false); setReason("");
          }, c.read_only ? "Write access granted" : "Write access revoked")}>{c.read_only ? "Grant" : "Revoke"}</Button></>}>
        {c.read_only ? (
          <Field label="Business justification" hint="Required. Stored in the audit log.">
            <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Managers update customer profile fields (CHG-1234)" />
          </Field>
        ) : <p className="text-sm">Write workflows using this connector will fail validation until access is granted again.</p>}
      </Modal>
    </>
  );
}

function Item({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3"><dt className="text-ink-3 shrink-0">{k}</dt><dd className="text-right min-w-0">{v}</dd></div>;
}
