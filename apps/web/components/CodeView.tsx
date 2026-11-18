"use client";

import dynamic from "next/dynamic";

import { CodeBlock, Spinner } from "./ui";

const Monaco = dynamic(() => import("@monaco-editor/react").then((m) => m.default), { ssr: false, loading: () => <Spinner label="Loading editor" /> });
const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), { ssr: false, loading: () => <Spinner label="Loading diff" /> });

const LANG: Record<string, string> = { json: "json", py: "python", graphql: "graphql", rego: "plaintext", yaml: "yaml", yml: "yaml", md: "markdown", ts: "typescript" };

export function langFor(name: string) {
  if (name === "Dockerfile") return "dockerfile";
  return LANG[name.split(".").pop() || ""] || "plaintext";
}

/** Read-only by default: generated code is a build artefact, the spec is the source of truth. */
export function CodeView({ value, language = "json", height = 460, readOnly = true, onChange }: {
  value: string; language?: string; height?: number; readOnly?: boolean; onChange?: (v: string) => void;
}) {
  if (typeof window !== "undefined" && (window as any).__APF_NO_MONACO) return <CodeBlock code={value} maxHeight={height} />;
  return (
    <div className="border border-line rounded overflow-hidden">
      <Monaco height={height} language={language} value={value} onChange={(v) => onChange?.(v || "")}
        options={{ readOnly, minimap: { enabled: false }, fontSize: 12.5, fontFamily: "IBM Plex Mono, monospace", scrollBeyondLastLine: false,
          lineNumbersMinChars: 3, renderLineHighlight: "none", wordWrap: "on", tabSize: 2 }} />
    </div>
  );
}

export function DiffView({ original, modified, height = 480 }: { original: string; modified: string; height?: number }) {
  return (
    <div className="border border-line rounded overflow-hidden">
      <MonacoDiff height={height} language="json" original={original} modified={modified}
        options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, fontFamily: "IBM Plex Mono, monospace" }} />
    </div>
  );
}
