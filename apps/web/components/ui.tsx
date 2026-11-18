"use client";

import clsx from "clsx";
import { Check, Copy, Loader2, X } from "lucide-react";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

/* ------------------------------------------------------------------ Button */
type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary", size = "md", loading, icon, className, children, ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean; icon?: React.ReactNode }) {
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-signal text-white hover:bg-signal-2",
        variant === "secondary" && "bg-white text-ink border border-line hover:border-ink-4",
        variant === "ghost" && "text-ink-2 hover:bg-ink/5",
        variant === "danger" && "bg-white text-danger border border-danger/30 hover:bg-danger-soft",
        className,
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ Badge */
type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "rest" | "gql" | "mcp";
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 h-5 px-1.5 rounded-sm text-2xs font-medium whitespace-nowrap",
        tone === "neutral" && "bg-ink/[0.06] text-ink-2",
        tone === "good" && "bg-signal-soft text-signal-2",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "bad" && "bg-danger-soft text-danger",
        tone === "info" && "bg-rest-soft text-rest",
        tone === "rest" && "bg-rest-soft text-rest",
        tone === "gql" && "bg-gql-soft text-gql",
        tone === "mcp" && "bg-mcp-soft text-mcp",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: "good" | "warn" | "bad" | "neutral" }) {
  return (
    <span className={clsx("inline-block h-2 w-2 rounded-full",
      tone === "good" && "bg-signal", tone === "warn" && "bg-warn", tone === "bad" && "bg-danger", tone === "neutral" && "bg-ink-4")} />
  );
}

export function statusTone(s?: string): Tone {
  if (!s) return "neutral";
  if (["active", "healthy", "passed", "validated", "released", "approved", "allow", "success", "ok"].includes(s)) return "good";
  if (["pending", "pending_approval", "untested", "draft", "superseded"].includes(s)) return "warn";
  if (["failing", "failed", "rejected", "deny", "failure", "stopped", "blocked", "disabled"].includes(s)) return "bad";
  return "neutral";
}

/* ------------------------------------------------------------------ Layout */
export function PageHeader({ title, description, actions, meta }: {
  title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; meta?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 mb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-3 max-w-[72ch]">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className, bodyClass, description }: {
  title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string;
  description?: React.ReactNode;
}) {
  return (
    <section className={clsx("panel", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 h-11 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">{title}</h2>
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {description && <p className="px-4 pt-3 text-xs text-ink-3">{description}</p>}
      <div className={clsx(bodyClass ?? "p-4")}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "bad" | "warn" | "good" }) {
  return (
    <div className="panel px-4 py-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={clsx("mt-1 text-xl font-semibold tabular-nums",
        tone === "bad" && "text-danger", tone === "warn" && "text-warn", tone === "good" && "text-signal-2")}>{value}</div>
      {sub && <div className="text-2xs text-ink-4 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      {icon && <div className="mb-3 text-ink-4">{icon}</div>}
      <div className="text-sm font-semibold">{title}</div>
      {children && <div className="mt-1 text-sm text-ink-3 max-w-[48ch]">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-3 py-8 justify-center">
      <Loader2 className="h-4 w-4 animate-spin" /> {label ?? "Loading"}
    </div>
  );
}

export function ErrorNote({ error }: { error?: any }) {
  if (!error) return null;
  return <div className="rounded border border-danger/30 bg-danger-soft text-danger text-sm px-3 py-2">{error.message || String(error)}</div>;
}

/* ------------------------------------------------------------------ Tabs */
export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: React.ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="tablist" className={clsx("flex items-center gap-1 border-b border-line overflow-x-auto", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            "relative h-10 px-3 text-sm whitespace-nowrap transition-colors",
            value === t.id ? "text-ink font-medium" : "text-ink-3 hover:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-2xs text-ink-4 tabular-nums">{t.count}</span>}
          {value === t.id && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-signal rounded-full" />}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Forms */
export function Field({ label, hint, children, error }: { label: string; hint?: React.ReactNode; children: React.ReactNode; error?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && !error && <span className="block mt-1 text-2xs text-ink-4">{hint}</span>}
      {error && <span className="block mt-1 text-2xs text-danger">{error}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, className, placeholder }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[];
  className?: string; placeholder?: string;
}) {
  return (
    <select className={clsx("input pr-8", className)} value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={clsx("inline-flex items-center gap-2 text-sm disabled:opacity-50")}>
      <span className={clsx("relative inline-block shrink-0 h-5 w-9 rounded-full transition-colors", checked ? "bg-signal" : "bg-ink/15")}>
        <span className={clsx("absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
      {label}
    </button>
  );
}

export function TagInput({ value, onChange, placeholder, suggestions }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = (v: string) => {
    const t = v.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  const listId = React.useId();
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-h-9 px-2 py-1.5 rounded border border-line bg-white focus-within:border-signal">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-sm bg-paper text-xs font-mono">
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="text-ink-4 hover:text-ink">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        list={suggestions ? listId : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
          if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft && add(draft)}
        placeholder={value.length ? "" : placeholder}
        className="flex-1 min-w-[8ch] text-sm outline-none bg-transparent"
      />
      {suggestions && <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

/* ------------------------------------------------------------------ Overlays */
export function Drawer({ open, onClose, title, children, width = 480, footer }: {
  open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; width?: number; footer?: React.ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <aside role="dialog" aria-modal className="relative h-full bg-white shadow-pop flex flex-col" style={{ width }}>
        <header className="flex items-center justify-between h-12 px-4 border-b border-line">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="border-t border-line p-3 flex justify-end gap-2">{footer}</footer>}
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: {
  open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div role="dialog" aria-modal className="relative bg-white rounded-md shadow-pop w-full max-h-[80vh] flex flex-col" style={{ maxWidth: width }}>
        <header className="flex items-center justify-between h-12 px-4 border-b border-line">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>
        </header>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <footer className="border-t border-line p-3 flex justify-end gap-2">{footer}</footer>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Code */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="inline-flex items-center gap-1 text-2xs text-ink-3 hover:text-ink"
      aria-label="Copy"
    >
      {done ? <Check className="h-3.5 w-3.5 text-signal" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

export function CodeBlock({ code, className, maxHeight = 420, dark }: { code: string; className?: string; maxHeight?: number; dark?: boolean }) {
  return (
    <div className={clsx("relative group rounded border", dark ? "bg-ink border-ink text-white/90" : "bg-paper/60 border-line", className)}>
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity"><CopyButton text={code} /></div>
      <pre className="code p-3 overflow-auto whitespace-pre" style={{ maxHeight }}>{code}</pre>
    </div>
  );
}

/* ------------------------------------------------------------------ Toasts */
type ToastT = { id: number; text: string; tone: "good" | "bad" | "neutral" };
const ToastCtx = createContext<(text: string, tone?: ToastT["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((text: string, tone: ToastT["tone"] = "good") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx("px-4 py-2 rounded shadow-pop text-sm text-white max-w-[60ch]",
            t.tone === "bad" ? "bg-danger" : t.tone === "neutral" ? "bg-ink-2" : "bg-ink")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
