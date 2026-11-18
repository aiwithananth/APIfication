"use client";

import clsx from "clsx";
import { Rocket } from "lucide-react";
import Link from "next/link";

import { Badge, Button, Empty, PageHeader, Panel, Spinner, statusTone, useToast } from "@/components/ui";
import { post, timeAgo, useApi } from "@/lib/api";

const ENVS = [
  { id: "development", gate: "Validated revision", dot: "bg-signal" },
  { id: "staging", gate: "Passing test run for the revision", dot: "bg-warn" },
  { id: "production", gate: "Approved release request", dot: "bg-danger" },
];

export default function Deployments() {
  const { data, isLoading, mutate } = useApi<any[]>("/v1/deployments");
  const { data: caps } = useApi<any[]>("/v1/capabilities");
  const toast = useToast();
  if (isLoading) return <Spinner />;
  const active = (data || []).filter((d) => d.status === "active");

  async function promote(capId: string, env: string) {
    try {
      const r = await post("/v1/deployments", { capability_id: capId, environment: env });
      toast(r.status === "pending_approval" ? "Release request sent to Approvals" : `Deployed r${r.revision_number} to ${env}`, r.status === "pending_approval" ? "neutral" : "good");
      mutate();
    } catch (e: any) { toast(e.message, "bad"); }
  }

  return (
    <>
      <PageHeader title="Deployments & environments" description="Deployments promote immutable revisions. Each environment has a gate; production always needs an approver." />
      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Capability</th>{ENVS.map((e) => <th key={e.id}><span className="inline-flex items-center gap-1.5 capitalize"><span className={clsx("h-2 w-2 rounded-full", e.dot)} />{e.id}</span><div className="font-normal text-2xs text-ink-4">{e.gate}</div></th>)}</tr></thead>
          <tbody>
            {!caps?.length && <tr><td colSpan={4}><Empty icon={<Rocket className="h-6 w-6" />} title="Nothing to deploy yet" /></td></tr>}
            {(caps || []).map((c) => (
              <tr key={c.id}>
                <td><Link href={`/capabilities/${c.id}`} className="font-medium hover:underline">{c.name}</Link><div className="text-2xs text-ink-4">latest r{c.latest_revision} · {c.revision_status}</div></td>
                {ENVS.map((e, i) => {
                  const d = active.find((x) => x.capability_id === c.id && x.environment === e.id);
                  const prev = i === 0 || active.some((x) => x.capability_id === c.id && x.environment === ENVS[i - 1].id);
                  return (
                    <td key={e.id}>
                      {d ? (
                        <div className="flex items-center gap-2">
                          <Badge tone="good">r{d.revision_number}</Badge>
                          <span className="text-2xs text-ink-4">{timeAgo(d.created_at)}</span>
                          {d.revision_number !== c.latest_revision && <Button size="sm" onClick={() => promote(c.id, e.id)}>Update to r{c.latest_revision}</Button>}
                        </div>
                      ) : (
                        <Button size="sm" disabled={!prev} onClick={() => promote(c.id, e.id)}>{e.id === "production" ? "Request release" : "Deploy"}</Button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Panel title="History" className="mt-5" bodyClass="p-0">
        <table className="tbl"><thead><tr><th>Deployment</th><th>Environment</th><th>Revision</th><th>Status</th><th>By</th><th>Digest</th><th className="text-right"></th></tr></thead>
          <tbody>{(data || []).map((d) => (
            <tr key={d.id}>
              <td>{d.capability_name}</td><td className="capitalize">{d.environment}</td><td>r{d.revision_number}</td>
              <td><Badge tone={statusTone(d.status)}>{d.status}</Badge></td><td className="text-xs text-ink-3">{d.deployed_by}{d.approval_id && " · approved"}</td>
              <td className="font-mono text-2xs text-ink-4">{d.digest?.slice(7, 19)}</td>
              <td className="text-right">{d.status === "active" && <Button size="sm" variant="ghost" onClick={async () => { await post(`/v1/deployments/${d.id}/undeploy`); toast("Deployment stopped"); mutate(); }}>Stop</Button>}</td>
            </tr>
          ))}</tbody></table>
      </Panel>
      <p className="mt-3 text-2xs text-ink-4">Roll back by deploying an earlier revision from the capability&apos;s Revisions tab, or stop a deployment here.</p>
    </>
  );
}
