"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type Env = "development" | "staging" | "production";

type Ctx = {
  env: Env;
  setEnv: (e: Env) => void;
  assistantOpen: boolean;
  setAssistantOpen: (v: boolean) => void;
  /** Page-provided context sent with each assistant message (capability, project, selection). */
  pageContext: Record<string, any>;
  setPageContext: (c: Record<string, any>) => void;
  askAssistant: (q: string) => void;
  pendingQuestion: string | null;
  clearPending: () => void;
};

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [env, setEnvState] = useState<Env>("development");
  const [assistantOpen, setAssistantOpenState] = useState(false);
  const [pageContext, setPageContext] = useState<Record<string, any>>({});
  const [pendingQuestion, setPending] = useState<string | null>(null);

  useEffect(() => {
    try {
      const e = localStorage.getItem("apf.env") as Env | null;
      if (e) setEnvState(e);
      if (localStorage.getItem("apf.assistant") === "1") setAssistantOpenState(true);
    } catch { /* storage unavailable */ }
  }, []);

  const setEnv = (e: Env) => {
    setEnvState(e);
    try { localStorage.setItem("apf.env", e); } catch { /* ignore */ }
  };
  const setAssistantOpen = (v: boolean) => {
    setAssistantOpenState(v);
    try { localStorage.setItem("apf.assistant", v ? "1" : "0"); } catch { /* ignore */ }
  };

  return (
    <AppCtx.Provider value={{
      env, setEnv, assistantOpen, setAssistantOpen, pageContext, setPageContext,
      askAssistant: (q) => { setPending(q); setAssistantOpen(true); },
      pendingQuestion, clearPending: () => setPending(null),
    }}>
      {children}
    </AppCtx.Provider>
  );
}

export function useApp() {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

/** Pages call this to tell the assistant what the user is looking at. */
export function usePageContext(ctx: Record<string, any>, deps: unknown[]) {
  const { setPageContext } = useApp();
  useEffect(() => {
    setPageContext(ctx);
    return () => setPageContext({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
