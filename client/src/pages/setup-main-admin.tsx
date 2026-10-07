import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Field } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";

type SetupStatus = { needsMainAdmin: boolean; tokenConfigured: boolean; setupEnabled: boolean };

export function SetupMainAdminPage() {
  const navigate = useNavigate();
  const { applySession, refresh } = useAuth();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const showToast = useToast();

  useEffect(() => {
    api<SetupStatus>("/api/auth/setup-main-admin/status")
      .then(setStatus)
      .catch(() => setStatus({ needsMainAdmin: false, tokenConfigured: false, setupEnabled: false }));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const session = await api<{ user: { role: string } }>("/api/auth/setup-main-admin", {
        method: "POST",
        body: JSON.stringify({ setupToken, username, password, name: name || undefined }),
      });
      applySession(session as Parameters<typeof applySession>[0]);
      void refresh();
      navigate("/platform", { replace: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not create main admin", "error");
    } finally {
      setBusy(false);
    }
  }

  if (status === null) {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-8">
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  if (!status.needsMainAdmin) {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-8">
        <div className="w-full max-w-md rounded-[20px] border border-line bg-white p-5 text-center shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
          <h1 className="text-xl font-semibold">Main admin setup</h1>
          <p className="mt-2 text-sm text-muted">A main admin already exists. Sign in with that account.</p>
          <Link to="/" className="mt-4 inline-block text-sm font-semibold text-moss">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!status.tokenConfigured) {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-8">
        <div className="w-full max-w-md rounded-[20px] border border-line bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
          <h1 className="text-xl font-semibold">Main admin setup</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            The database has no main admin yet. On <strong>Render</strong>, open your web service → <strong>Environment</strong> → add:
          </p>
          <p className="mt-3 rounded-xl bg-paper-deep px-3 py-2 font-mono text-xs">MAIN_ADMIN_SETUP_TOKEN</p>
          <p className="mt-2 text-sm text-muted">Use a random string at least 16 characters. Save, redeploy, then reload this page.</p>
          <p className="mt-3 text-sm text-muted">
            Or run <code className="text-xs">bootstrap-main-admin.ts</code> locally with your Render <strong>External</strong> database URL (see docs/DEPLOY-RENDER.md).
          </p>
          <Link to="/" className="mt-4 inline-block text-sm font-semibold text-moss">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-semibold">Create main admin</h1>
          <p className="mt-2 text-sm text-muted">
            Enter the same setup token you set in Render. After success, remove <code className="text-xs">MAIN_ADMIN_SETUP_TOKEN</code> and redeploy.
          </p>
        </div>
        <form onSubmit={submit} className="grid gap-4 rounded-[20px] border border-line bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
          <Field label="Setup token" type="password" value={setupToken} onChange={setSetupToken} placeholder="From Render env" />
          <Field label="Your name" value={name} onChange={setName} placeholder="Main admin" />
          <Field label="Username" value={username} onChange={setUsername} placeholder="main" />
          <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" />
          <Button type="submit" disabled={busy || setupToken.length < 16 || username.length < 3 || password.length < 8}>
            {busy ? "Creating…" : "Create and sign in"}
          </Button>
          <Link to="/" className="text-center text-sm font-semibold text-muted">
            Back to sign in
          </Link>
        </form>
      </div>
    </div>
  );
}
