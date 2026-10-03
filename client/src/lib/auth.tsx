import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

export type Session = {
  user: { userId: string; name: string; role: "MAIN_ADMIN" | "OWNER" | "ADMIN" | "MEMBER"; memberId: string | null; username?: string };
  society: { id: string; name: string; logoUrl: string | null };
};

const AuthContext = createContext<{
  session: Session | null;
  loading: boolean;
  refresh: () => Promise<void>;
  applySession: (next: Session) => void;
  logout: () => Promise<void>;
} | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionKnown = useRef(false);

  function applySession(next: Session) {
    sessionKnown.current = true;
    setSession(next);
    setLoading(false);
  }

  async function refresh() {
    try {
      const data = await api<Session | { user: null; society: null }>("/api/auth/me");
      if (data.user) {
        sessionKnown.current = true;
        setSession(data as Session);
      } else {
        sessionKnown.current = false;
        setSession(null);
      }
    } catch {
      if (!sessionKnown.current) setSession(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    let lastCheck = Date.now();
    const onFocus = () => {
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    sessionKnown.current = false;
    setSession(null);
  }

  return <AuthContext.Provider value={{ session, loading, refresh, applySession, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Auth missing");
  return value;
}
