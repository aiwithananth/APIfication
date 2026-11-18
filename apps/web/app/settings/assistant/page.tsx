"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useApp } from "@/components/AppContext";
import { Badge, Button, Field, PageHeader, Panel, Select, Spinner, useToast } from "@/components/ui";
import { patch, useApi } from "@/lib/api";

export default function AssistantSettings() {
  const { data: agents, mutate } = useApi<any[]>("/v1/agents");
  const { data: providers } = useApi<any[]>("/v1/model-providers");
  const { setAssistantOpen } = useApp();
  const toast = useToast();
  const a = agents?.find((x) => x.key === "assistant");
  const [prov, setProv] = useState("");
  useEffect(() => { if (a) setProv(a.provider_id || ""); }, [a]);
  if (!a) return <Spinner />;
  const def = providers?.find((p) => p.is_default && p.provider_type !== "builtin");
  return (
    <>
      <PageHeader title="Assistant" description="The in-app assistant answers questions about the platform and acts for the signed-in user, inside the same governance rules." />
      <div className="space-y-5">
        <Panel title="Model">
          <div className="max-w-md space-y-3">
            <Field label="Provider" hint={def ? `Organisation default: ${def.name} · ${def.model}` : "No default provider — the built-in engine answers from the product guide and can still act."}>
              <Select value={prov} onChange={setProv} placeholder="Organisation default" options={(providers || []).filter((p) => p.provider_type !== "builtin").map((p) => ({ value: p.id, label: `${p.name} · ${p.model}` }))} />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" onClick={async () => { await patch(`/v1/agents/${a.id}`, { provider_id: prov || null }); toast("Assistant model saved"); mutate(); }}>Save</Button>
              <Button onClick={() => setAssistantOpen(true)}>Open assistant</Button>
            </div>
            <p className="text-xs text-ink-3">Add providers in <Link href="/settings/providers" className="underline">Model providers</Link>.</p>
          </div>
        </Panel>
        <Panel title="What it can do">
          <div className="flex flex-wrap gap-1.5">{a.tools.map((t: string) => <Badge key={t} className="font-mono">{t}</Badge>)}</div>
          <ul className="mt-4 text-sm space-y-1.5 text-ink-2">
            <li>Answers from the product guide and the architecture specification, with the page you are on as context.</li>
            <li>Creates projects, generates capabilities, runs tests and deploys to development.</li>
            <li>Cannot approve requests, promote to staging or production, or read secrets. Those stay with people.</li>
            <li>Every assistant action is recorded in the audit log.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
