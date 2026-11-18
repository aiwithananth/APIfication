"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, ErrorNote, Field, Modal, useToast } from "@/components/ui";
import { post } from "@/lib/api";

export function NewProject({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (p: any) => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>();
  const router = useRouter();
  const toast = useToast();
  async function create() {
    setBusy(true); setErr(undefined);
    try {
      const p = await post("/v1/projects", { name, description: desc });
      toast(`Created project ${p.name}`);
      onCreated?.(p); onClose(); setName(""); setDesc("");
      router.push(`/projects/${p.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="New project"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={busy} onClick={create}>Create project</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments" /></Field>
        <Field label="Description"><textarea className="textarea" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <ErrorNote error={err} />
      </div>
    </Modal>
  );
}
