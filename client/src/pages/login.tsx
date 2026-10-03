import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Field } from "../components/ui";
import { api } from "../lib/api";
import { useAuth, type Session } from "../lib/auth";

/** Dev only: in the browser console, `localStorage.setItem("society.showDemoLogins", "1")` then reload. */
const DEMO_LOGINS_STORAGE_KEY = "society.showDemoLogins";

function demoLoginsEnabled() {
  try {
    const value = localStorage.getItem(DEMO_LOGINS_STORAGE_KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

const shortcuts = [
  { label: "Main admin", hint: "Create society admins", username: "main", password: "Main@2026" },
  { label: "Society admin", hint: "office — edit members and payments", username: "office", password: "office@123" },
  { label: "Member", hint: "View your own account", username: "m1", password: "Member@2026" },
];

type Choice = { userId: string; role: string; name: string; societyName: string; logoUrl: string | null };
type LoginResult = Session | { societies: Choice[]; selectionToken: string };

export function LoginPage() {
  const navigate = useNavigate();
  const { applySession, refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selectionToken, setSelectionToken] = useState("");
  const [showDemoLogins, setShowDemoLogins] = useState(demoLoginsEnabled);
  const [needsMainAdmin, setNeedsMainAdmin] = useState(false);

  useEffect(() => {
    api<{ needsMainAdmin: boolean }>("/api/auth/setup-main-admin/status")
      .then((row) => setNeedsMainAdmin(row.needsMainAdmin))
      .catch(() => setNeedsMainAdmin(false));
  }, []);

  useEffect(() => {
    const sync = () => setShowDemoLogins(demoLoginsEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  function land(next: Session) {
    applySession(next);
    void refresh();
    const role = next.user.role;
    navigate(role === "MAIN_ADMIN" ? "/platform" : role === "MEMBER" ? "/me" : "/app", { replace: true });
  }

  async function signIn(nextUsername: string, nextPassword: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<LoginResult>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: nextUsername, password: nextPassword }),
      });
      /** The same person can hold accounts in several societies. Open the one they pick. */
      if ("societies" in result && result.selectionToken) {
        setChoices(result.societies);
        setSelectionToken(result.selectionToken);
        return;
      }
      if ("user" in result && result.user) land(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function chooseSociety(choice: Choice) {
    setBusy(true);
    setError("");
    try {
      const result = await api<LoginResult>("/api/auth/login/select", {
        method: "POST",
        body: JSON.stringify({ selectionToken, userId: choice.userId }),
      });
      if ("user" in result && result.user) land(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that society");
      setChoices([]);
      setSelectionToken("");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void signIn(username, password);
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-moss text-2xl font-semibold text-white">₹</div>
          <h1 className="mt-4 text-3xl font-semibold">Society Finance</h1>
          <p className="mt-2 text-base text-muted">{choices.length > 0 ? "Choose the society you want to open." : "Sign in with the username your admin gave you."}</p>
        </div>
        {choices.length > 0 ? (
          <div className="grid gap-2 rounded-[20px] border border-line bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
            {choices.map((choice) => (
              <button
                key={choice.userId}
                type="button"
                disabled={busy}
                onClick={() => void chooseSociety(choice)}
                className="flex min-h-16 items-center gap-3 rounded-[20px] border border-line px-4 text-left disabled:opacity-50"
              >
                {choice.logoUrl
                  ? <img src={choice.logoUrl} alt="" className="h-11 w-11 shrink-0 rounded-2xl object-cover" />
                  : <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-moss text-base font-semibold text-white">{choice.societyName.trim().charAt(0)}</span>}
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold">{choice.societyName}</span>
                  <span className="block truncate text-sm text-muted">{choice.name} · {choice.role === "MEMBER" ? "Member" : choice.role === "MAIN_ADMIN" ? "Main admin" : "Society admin"}</span>
                </span>
              </button>
            ))}
            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-clay">{error}</p>}
            <button type="button" className="mt-1 min-h-11 text-sm font-semibold text-muted" onClick={() => { setChoices([]); setSelectionToken(""); setPassword(""); }}>
              Use a different login
            </button>
          </div>
        ) : (
        <form onSubmit={submit} className="grid gap-4 rounded-[20px] border border-line bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
          <Field label="Username" value={username} onChange={setUsername} placeholder="Your username" />
          <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="Your password" />
          {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-clay">{error}</p>}
          <Button type="submit" disabled={busy || !username || !password}>{busy ? "Signing in…" : "Sign in"}</Button>
          {needsMainAdmin && (
            <p className="text-center text-sm text-muted">
              No main admin yet.{" "}
              <Link to="/setup" className="font-semibold text-moss">
                Open setup (/setup)
              </Link>
            </p>
          )}
        </form>
        )}
        {showDemoLogins && (
          <div className="mt-6">
            <div className="mb-2 text-sm font-medium text-muted">Or open a demo account</div>
            <div className="grid gap-2">
              {shortcuts.map((item) => (
                <button
                  key={item.username}
                  type="button"
                  disabled={busy}
                  onClick={() => void signIn(item.username, item.password)}
                  className="flex min-h-16 items-center justify-between rounded-[20px] border border-line bg-white px-4 text-left disabled:opacity-50"
                >
                  <span>
                    <span className="block text-base font-semibold">{item.label}</span>
                    <span className="block text-sm text-muted">{item.hint}</span>
                  </span>
                  <span className="text-sm font-semibold text-moss">Open</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
