"use client";

import clsx from "clsx";
import { ArrowUp, BookOpen, Eraser, Loader2, Maximize2, Minimize2, Sparkles, Wrench, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { post, refreshAll, useApi } from "@/lib/api";
import { useApp } from "./AppContext";

type Msg = {
  role: "user" | "assistant";
  content: string;
  actions?: { type: string; path?: string; label?: string }[];
  tools?: string[];
  sources?: { title: string; source: string }[];
  engine?: string;
  notice?: string;
};

const STORE = "apf.assistant.messages";

export function Assistant({ onClose }: { onClose: () => void }) {
  const path = usePathname();
  const router = useRouter();
  const { pageContext, pendingQuestion, clearPending, env } = useApp();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [wide, setWide] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const { data: suggestions } = useApi<string[]>(`/v1/assistant/suggestions?page=${encodeURIComponent(path)}`);
  const { data: providers } = useApi<any[]>("/v1/model-providers");
  const llm = providers?.find((p) => p.is_default && p.provider_type !== "builtin");

  useEffect(() => {
    try { const s = sessionStorage.getItem(STORE); if (s) setMsgs(JSON.parse(s)); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ }
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);
  useEffect(() => {
    if (pendingQuestion) { send(pendingQuestion); clearPending(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuestion]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setDraft("");
    setBusy(true);
    try {
      const r = await post("/v1/assistant/chat", {
        messages: next.map((m) => ({ role: m.role, content: m.content })).slice(-14),
        context: { page: path, environment: env, ...pageContext },
      });
      setMsgs([...next, { role: "assistant", content: r.reply, actions: r.actions, tools: r.tools_used, sources: r.sources, engine: r.engine, notice: r.notice }]);
      if (r.actions?.some((a: any) => a.type === "refresh")) refreshAll();
      const nav = r.actions?.find((a: any) => a.type === "navigate");
      if (nav && (r.tools_used?.includes("navigate") || /^Opening /.test(r.reply))) router.push(nav.path);
    } catch (e: any) {
      setMsgs([...next, { role: "assistant", content: `I couldn't complete that: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside aria-label="Assistant" className={clsx("shrink-0 border-l border-line bg-white flex flex-col", wide ? "w-[560px]" : "w-[380px]")}>
      <header className="h-12 px-4 flex items-center gap-2 border-b border-line">
        <Sparkles className="h-4 w-4 text-signal" />
        <div className="text-sm font-semibold">Assistant</div>
        <span className="text-2xs text-ink-4 truncate">{llm ? `${llm.name} · ${llm.model}` : "Built-in engine"}</span>
        <div className="ml-auto flex items-center gap-1 text-ink-3">
          <button onClick={() => setMsgs([])} title="Clear conversation" aria-label="Clear conversation" className="p-1.5 rounded hover:bg-paper"><Eraser className="h-3.5 w-3.5" /></button>
          <button onClick={() => setWide(!wide)} title={wide ? "Narrow" : "Widen"} aria-label="Resize" className="p-1.5 rounded hover:bg-paper">
            {wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button onClick={onClose} aria-label="Close assistant" className="p-1.5 rounded hover:bg-paper"><X className="h-3.5 w-3.5" /></button>
        </div>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {msgs.length === 0 && (
          <div className="text-sm text-ink-2">
            <p className="font-medium">Ask about anything in APIfication, or ask me to do it.</p>
            <p className="mt-1 text-ink-3 text-[13px]">I can explain features, generate capabilities from a description, run tests,
              deploy to development and explain validation errors. I see which page you&apos;re on.</p>
            {!llm && (
              <p className="mt-3 text-xs text-ink-3 border-l-2 border-warn pl-2">Running on the built-in engine. Add a model provider in Settings for open-ended conversation.</p>
            )}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={clsx(m.role === "user" ? "flex justify-end" : "")}>
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-md bg-ink text-white text-[13px] px-3 py-2 whitespace-pre-wrap">{m.content}</div>
            ) : (
              <div className="text-[13px] text-ink">
                <div className="prose-chat"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                {m.actions && m.actions.filter((a) => a.type === "navigate").length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.actions.filter((a) => a.type === "navigate").map((a, j) => (
                      <button key={j} onClick={() => router.push(a.path!)}
                        className="h-7 px-2.5 rounded border border-line text-xs hover:border-signal hover:text-signal-2">{a.label}</button>
                    ))}
                  </div>
                )}
                {(m.tools?.length || m.sources?.length || m.notice) ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-4">
                    {m.tools && m.tools.length > 0 && <span className="inline-flex items-center gap-1"><Wrench className="h-3 w-3" />{Array.from(new Set(m.tools)).join(", ")}</span>}
                    {m.sources && m.sources.length > 0 && <span className="inline-flex items-center gap-1"><BookOpen className="h-3 w-3" />{m.sources.map((s) => s.title).slice(0, 2).join("; ")}</span>}
                    {m.notice && <span className="text-warn">{m.notice}</span>}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…</div>}
      </div>

      {suggestions && msgs.length < 2 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button key={s} onClick={() => send(s)} className="text-left text-xs px-2.5 py-1.5 rounded border border-line text-ink-2 hover:border-signal hover:text-signal-2 max-w-full">
              {s}
            </button>
          ))}
        </div>
      )}
      <form className="p-3 border-t border-line" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
        <div className="flex items-end gap-2 rounded border border-line focus-within:border-signal px-2 py-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); } }}
            rows={Math.min(5, Math.max(1, draft.split("\n").length))}
            placeholder="Ask or describe what you need…"
            className="flex-1 resize-none text-[13px] outline-none py-1 bg-transparent"
            aria-label="Message the assistant"
          />
          <button type="submit" disabled={!draft.trim() || busy} aria-label="Send"
            className="h-7 w-7 rounded bg-signal text-white flex items-center justify-center disabled:opacity-40">
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1.5 text-2xs text-ink-4">Enter to send · Shift+Enter for a new line · ⌘/ to toggle</div>
      </form>
    </aside>
  );
}
