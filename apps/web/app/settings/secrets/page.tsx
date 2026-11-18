"use client";

import { Lock } from "lucide-react";

import { Empty, PageHeader, Panel, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";

export default function Secrets() {
  const { data } = useApi<any[]>("/v1/vault/refs");
  if (!data) return <Spinner />;
  return (
    <>
      <PageHeader title="Secrets vault" description="Registry records hold only references. Values are encrypted at rest and resolved by the runtime at execution time." />
      <Panel bodyClass="p-0" description="Development uses a local encrypted vault. In production, point the vault backend at HashiCorp Vault, OpenBao or your cloud secret manager.">
        {!data.length ? <Empty icon={<Lock className="h-6 w-6" />} title="No secrets stored">Secrets appear when you register connectors or model providers with credentials.</Empty> : (
          <table className="tbl"><thead><tr><th>Reference</th><th>Label</th><th>Owner</th><th>Value</th></tr></thead>
            <tbody>{data.map((s) => (
              <tr key={s.ref}><td className="font-mono text-xs">{s.ref}</td><td>{s.label}</td><td className="text-ink-3">{s.owner}</td><td className="text-ink-4 text-xs inline-flex items-center gap-1"><Lock className="h-3 w-3" /> never displayed</td></tr>
            ))}</tbody></table>
        )}
      </Panel>
    </>
  );
}
