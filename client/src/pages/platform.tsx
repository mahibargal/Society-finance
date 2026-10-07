import { useEffect, useState } from "react";
import { Shell } from "../components/shell";
import { Button, Card, Empty, Field, ListSkeleton, Segmented } from "../components/ui";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

type SocietyRow = {
  id: string;
  name: string;
  members: number;
  admins: { id: string; name: string; username: string; role: string; isActive: boolean }[];
};

export function PlatformHome() {
  const [societies, setSocieties] = useState<SocietyRow[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [societyId, setSocietyId] = useState("");
  const [societyName, setSocietyName] = useState("");
  const [monthlyShare, setMonthlyShare] = useState("500.00");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetId, setResetId] = useState("");
  const showToast = useToast();
  const [resetPassword, setResetPassword] = useState("");
  const [ready, setReady] = useState(false);
  const [statusPrompt, setStatusPrompt] = useState<{ adminId: string; adminName: string; next: boolean } | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);

  async function load() {
    const data = await api<{ societies: SocietyRow[] }>("/api/platform");
    setSocieties(data.societies);
    setSocietyId((current) => current || data.societies[0]?.id || "");
  }

  useEffect(() => { void load().finally(() => setReady(true)); }, []);

  function openAdminStatusPrompt(admin: SocietyRow["admins"][number]) {
    setStatusPrompt({ adminId: admin.id, adminName: admin.name, next: !admin.isActive });
    setStatusReason("");
  }

  function closeAdminStatusPrompt() {
    setStatusPrompt(null);
    setStatusReason("");
  }

  async function confirmAdminStatus() {
    if (!statusPrompt) return;
    const reason = statusReason.trim();
    if (reason.length < 3) {
      closeAdminStatusPrompt();
      showToast("Enter a reason with at least 3 characters (for example why this admin is being deactivated).", "error");
      return;
    }
    setStatusBusy(true);
    try {
      await api(`/api/platform/admins/${statusPrompt.adminId}/status`, {
        method: "POST",
        body: JSON.stringify({ active: statusPrompt.next, reason }),
      });
      const label = statusPrompt.adminName;
      const activated = statusPrompt.next;
      closeAdminStatusPrompt();
      showToast(activated ? `${label} is now active.` : `${label} is now inactive.`);
      await load();
    } catch (err) {
      closeAdminStatusPrompt();
      showToast(err instanceof Error ? err.message : "Could not update the admin", "error");
    } finally {
      setStatusBusy(false);
    }
  }

  return (
    <Shell platform>
      <div>
        <div className="text-sm font-medium text-moss">Main admin</div>
        <h1 className="num text-4xl">Societies</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted">Create a society admin such as abc, cde, or efg. That admin can see and edit every member in their society. Members can only view the login the admin gives them.</p>
      </div>
      <div className="grid gap-3">
        {!ready && <ListSkeleton count={3} />}
        {ready && societies.length === 0 && (
          <Empty title="No societies found" body="Create a society and the first admin to start a new book." />
        )}
        {societies.map((society) => (
          <Card key={society.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">{society.name}</div>
                <div className="text-sm text-muted">{society.members} members</div>
              </div>
              <div className="rounded-full bg-paper-deep px-3 py-1 text-xs font-medium text-moss">{society.admins.length} admins</div>
            </div>
            <div className="mt-4 grid gap-2">
              {society.admins.map((admin) => (
                <div key={admin.id} className="rounded-2xl bg-paper px-3 py-3 text-sm">
                  <div className="grid gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{admin.name}</div>
                      <div className="text-muted">@{admin.username}</div>
                      <div className={`mt-1 text-xs font-medium ${admin.isActive ? "text-moss" : "text-clay"}`}>
                        {admin.role === "OWNER" ? "Lead admin" : "Admin"} · {admin.isActive ? "Active" : "Inactive"}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="min-h-10 flex-1 rounded-2xl border border-line bg-white px-3 text-xs font-semibold sm:flex-none"
                        onClick={() => openAdminStatusPrompt(admin)}
                      >
                        {admin.isActive ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        type="button"
                        className="min-h-10 flex-1 rounded-2xl border border-line bg-white px-3 text-xs font-semibold sm:flex-none"
                        onClick={() => { setResetId(resetId === admin.id ? "" : admin.id); setResetPassword(""); }}
                      >
                        {resetId === admin.id ? "Cancel" : "Change password"}
                      </button>
                    </div>
                  </div>
                  {resetId === admin.id && (
                    <form className="mt-3 grid gap-2" onSubmit={async (event) => {
                      event.preventDefault();
                      try {
                        await api(`/api/platform/admins/${admin.id}/password`, { method: "POST", body: JSON.stringify({ next: resetPassword }) });
                        setResetPassword("");
                        setResetId("");
                        showToast(`New password saved for @${admin.username}. They must sign in again.`);
                      } catch (err) {
                        setResetId("");
                        showToast(err instanceof Error ? err.message : "Could not change the password", "error");
                      }
                    }}>
                      <Field label="New password" type="password" value={resetPassword} onChange={setResetPassword} placeholder="At least 8 characters" />
                      <Button type="submit" disabled={resetPassword.length < 8}>Save password</Button>
                    </form>
                  )}
                </div>
              ))}
              {society.admins.length === 0 && <p className="text-sm text-muted">No admin yet.</p>}
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <h2 className="text-xl font-semibold">Add a society admin</h2>
        <form className="mt-4 grid gap-3" onSubmit={async (event) => {
          event.preventDefault();
          try {
            const created = await api<{ username: string; societyName: string }>("/api/platform/admins", {
              method: "POST",
              body: JSON.stringify({
                societyId: mode === "existing" ? societyId : undefined,
                societyName: mode === "new" ? societyName : undefined,
                name,
                username,
                password,
                monthlyShare: mode === "new" ? monthlyShare : undefined,
              }),
            });
            showToast(`${created.username} can now sign in to ${created.societyName}.`);
            setName("");
            setUsername("");
            setPassword("");
            setSocietyName("");
            await load();
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Could not create the admin", "error");
          }
        }}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[{ id: "existing", label: "Existing society" }, { id: "new", label: "New society" }]}
          />
          {mode === "existing" ? (
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted">Society</span>
              <select value={societyId} onChange={(event) => setSocietyId(event.target.value)} className="min-h-12 w-full rounded-2xl border border-line bg-white px-4">
                {societies.map((society) => <option key={society.id} value={society.id}>{society.name}</option>)}
              </select>
            </label>
          ) : (
            <>
              <Field label="New society name" value={societyName} onChange={setSocietyName} placeholder="ABC Society" />
              <Field label="Monthly share for every member" value={monthlyShare} onChange={setMonthlyShare} inputMode="decimal" />
            </>
          )}
          <Field label="Admin name" value={name} onChange={setName} placeholder="ABC" />
          <Field label="Username" value={username} onChange={setUsername} placeholder="abc" />
          <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" />
          <Button type="submit">Create society admin</Button>
        </form>
      </Card>

      {statusPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-moss/25 p-3 backdrop-blur-[2px] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-status-reason-title"
          onClick={() => {
            if (statusBusy) return;
            closeAdminStatusPrompt();
          }}
        >
          <div className="w-full max-w-md rounded-[28px] bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h2 id="admin-status-reason-title" className="text-lg font-semibold">
              {statusPrompt.next ? "Activate admin" : "Deactivate admin"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {statusPrompt.next
                ? `Why are you activating ${statusPrompt.adminName}?`
                : `Why are you deactivating ${statusPrompt.adminName}?`}
            </p>
            <form
              className="mt-4 grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmAdminStatus();
              }}
            >
              <Field
                label="Reason"
                value={statusReason}
                onChange={setStatusReason}
                placeholder="At least 3 characters"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={statusBusy} disabled={statusBusy}>
                  {statusPrompt.next ? "Activate" : "Deactivate"}
                </Button>
                <Button
                  type="button"
                  tone="ghost"
                  disabled={statusBusy}
                  onClick={() => closeAdminStatusPrompt()}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Shell>
  );
}
