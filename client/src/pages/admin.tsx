import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck, ChevronDown, FileText, Landmark, Receipt, Users, Wallet } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { QuickTile } from "../components/home-links";
import { MemberHistoryTable } from "../components/member-history";
import { MonthCalendar } from "../components/month-calendar";
import { Shell } from "../components/shell";
import { Bone, Button, Card, Empty, Field, ListSkeleton, Money, PageSkeleton, PayoutBadge, Sheet, Stat } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { downloadFromResponse } from "../lib/download-blob";
import { downloadPaymentReceipt } from "../lib/payment-receipt";
import { useAuth } from "../lib/auth";
import { useBooksVersion, useBumpBooks } from "../lib/books-refresh";
import { formatINR, monthLabel, rupeesInWords, todayISO } from "../lib/format";
import { newId } from "../lib/id";
import { RegisterSetupBanner } from "../components/register-setup-banner";
import { confirmMemberDistributionChange } from "../lib/member-distribution-warning";
import { mobileError, mobileInput, normalizeMobile } from "../lib/phone";
import { clearImportDraft, loadImportDraft, saveImportDraft } from "../lib/import-draft";
import { addMembersBlockedMessage, allowManualMembers, clearManualMembersChoice, manualMembersAllowed, registerNeedsSetup, showAddMember } from "../lib/register-setup";
import { fetchMemberCards, fetchOpenPeriod, fetchRegisterPolicy } from "../lib/staff-data";

type Dashboard = {
  society: { name: string };
  period: string;
  month: string;
  members: { total: number; active: number };
  canAddMembers?: boolean;
  importedRegister?: boolean;
  shares: string;
  loansOutstanding: string;
  societyCash: string;
  societyCashLedger?: string;
  societyCashBreakdown?: {
    total: string;
    adds: { name: string; amount: string }[];
    less: { name: string; amount: string }[];
    also?: { name: string; amount: string }[];
  };
  monthCollected?: { total: string; share: string; interest: string; principal: string; penalty: string };
  interest: {
    accrued: string;
    collected: string;
    pending: string;
    distributed: string;
    available: string;
    combinedAvailable?: string;
    penaltyCollected?: string;
    penaltyAvailable?: string;
  };
  installment: { monthlyShare: string; previousInterest: string; currentInterest: string; principal: string; penalty: string; total: string; stillDue: string };
  series: { period: string; label: string; interestAccrued: string; interestCollected: string; interestDistributed: string; disbursed: string; principalRecovered: string }[];
};

type MemberCard = {
  username?: string;
  id: string;
  memberNumber: number;
  name: string;
  status: string;
  shareBalance: string;
  loanOutstanding: string;
  currentInterest: string;
  shareDue?: string;
  interestDue?: string;
  previousPending?: string;
  penaltyDue?: string;
  principalDue: string;
  scheduledPrincipal?: string;
  totalDue: string;
  interestEarned: string;
  interestBalance?: string;
  monthlyShare: string;
  collectedThisOpenMonth?: boolean;
};

type ReopenStatus = {
  canReopen: boolean;
  openMonth: string;
  previousMonth: string;
  blocked: string;
};

function ReopenPreviousCard() {
  const booksVersion = useBooksVersion();
  const bumpBooks = useBumpBooks();
  const [info, setInfo] = useState<ReopenStatus | null>(null);
  const [reason, setReason] = useState("Collection recorded wrongly. Reopen the previous month to correct it.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<ReopenStatus>("/api/monthly-close/reopen").then(setInfo).catch(() => setInfo(null));
  }, [booksVersion]);
  if (!info?.canReopen) return null;
  return (
    <Card>
      <h2 className="font-semibold">Go back to {info.previousMonth}</h2>
      <p className="mt-1 text-sm text-muted">
        If a receipt in {info.previousMonth} was wrong, reopen that month. You can change or delete payments there, then close it again.
        Only the last closed month can be reopened, and only while nothing has been collected in {info.openMonth}.
      </p>
      <div className="mt-3"><Field label="Reason" value={reason} onChange={setReason} /></div>
      {error && <p className="mt-2 text-sm text-clay">{error}</p>}
      <Button
        tone="ghost"
        full
        className="mt-3"
        disabled={busy || reason.trim().length < 3}
        onClick={async () => {
          if (!window.confirm(`Reopen ${info.previousMonth}? ${info.openMonth} will not stay open.`)) return;
          setBusy(true);
          try {
            await api("/api/monthly-close/reopen", { method: "POST", body: JSON.stringify({ confirm: true, reason: reason.trim() }) });
            bumpBooks();
            window.location.assign("/app/pay");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not reopen the previous month");
            setBusy(false);
          }
        }}
      >
        Reopen {info.previousMonth}
      </Button>
    </Card>
  );
}

export function AdminHome() {
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [societyCashBreakdownOpen, setSocietyCashBreakdownOpen] = useState(false);
  useEffect(() => {
    api<Dashboard>("/api/dashboard").then(setData).catch((err) => setError(err.message));
  }, [booksVersion]);
  if (error) return <Shell admin><p className="text-clay">{error}</p></Shell>;
  if (!data) return <Shell admin><PageSkeleton cards={2} /></Shell>;
  const monthCollected = data.monthCollected ?? { total: "0.00", share: "0.00", interest: "0.00", principal: "0.00", penalty: "0.00" };
  return (
    <Shell admin>
      <div className="rounded-[24px] bg-gradient-to-br from-moss to-[#0d9488] p-5 text-white shadow-[0_14px_40px_rgba(15,118,110,0.35)]">
        <div className="text-sm font-medium text-white/80">{data.month} is open</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Home</h1>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Link
            to="/app/month-collected"
            className="rounded-2xl bg-white/15 p-4 ring-1 ring-white/25 backdrop-blur-sm transition hover:bg-white/20"
          >
            <div className="text-xs uppercase tracking-wide text-white/80">Collected in {data.month}</div>
            <div className="num mt-1 text-3xl font-semibold">{formatINR(monthCollected.total)}</div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-white/80">
              <span>Share {formatINR(monthCollected.share)}</span>
              <span>Interest {formatINR(monthCollected.interest)}</span>
              <span>Principal {formatINR(monthCollected.principal)}</span>
              {Number(monthCollected.penalty) > 0 && <span>Penalty {formatINR(monthCollected.penalty)}</span>}
            </div>
            <div className="mt-2 text-xs font-medium text-white/90">View collected sheet →</div>
          </Link>
          <div className="flex flex-col justify-between gap-3 rounded-2xl bg-white/10 p-4 ring-1 ring-white/20">
            <div>
              <div className="text-xs uppercase tracking-wide text-white/70">Still to collect</div>
              <div className="num text-3xl">{formatINR(data.installment.stillDue)}</div>
              <Link to="/app/month-sheet" className="mt-1 inline-block text-xs font-medium text-white/85 underline-offset-2 hover:underline">
                Member dues sheet →
              </Link>
            </div>
            <Link to="/app/pay" className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-white px-5 text-sm font-semibold text-moss shadow-sm">
              Collect payment
            </Link>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <QuickTile to="/app/members" title="Members" hint="Register and logins" icon={Users} />
        <QuickTile to="/app/payments" title="Payments" hint="Receipts by month" icon={Receipt} />
        <QuickTile to="/app/loans" title="Loans" hint="Disburse and track" icon={Landmark} />
        <QuickTile to="/app/interest" title="Interest" hint="Pool and payout" icon={Wallet} />
        <QuickTile to="/app/close" title="Close month" hint="Reconcile and continue" icon={CalendarCheck} highlight />
        <QuickTile to="/app/reports" title="Reports" hint="Loans, interest, penalties" icon={FileText} />
      </div>
      {data.members.total === 0 && (
        registerNeedsSetup(data.members.total) ? (
          <RegisterSetupBanner />
        ) : showAddMember(data.members.total, data.canAddMembers !== false) ? (
          <Empty
            title="No members found"
            body="Add members to start collecting this month."
            action={<Link to="/app/members?new=1"><Button>Add</Button></Link>}
          />
        ) : (
          <Empty title="No members found" body={addMembersBlockedMessage(data.importedRegister === true)} />
        )
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card><div className="text-sm text-muted">Active members</div><div className="num text-4xl">{data.members.active}</div><div className="text-sm text-muted">{data.members.total} on the register</div></Card>
        <Card>
          <Stat
            large
            label="Member capital"
            value={data.shares}
            hint={
              data.monthCollected
                ? `Total shares on the ${data.month} sheet plus share collected this month (${formatINR(data.monthCollected.share)})`
                : "Total shares on the open month sheet plus share collected this month"
            }
          />
        </Card>
        <Card><Stat large label="Loans outstanding" value={data.loansOutstanding} hint="Loan principal not yet repaid" /></Card>
        <Card>
          <button
            type="button"
            className="w-full text-left"
            aria-expanded={societyCashBreakdownOpen}
            onClick={() => data.societyCashBreakdown && setSocietyCashBreakdownOpen((open) => !open)}
          >
            <Stat
              large
              label="Society cash"
              value={data.societyCash}
              hint={
                data.societyCashBreakdown
                  ? "Tap to show or hide how this total is calculated"
                  : "Member capital − loans outstanding + undistributed interest & penalty pool"
              }
            />
            {data.societyCashBreakdown && (
              <span className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-moss">
                {societyCashBreakdownOpen ? "Hide breakdown" : "Show breakdown"}
                <ChevronDown className={`h-4 w-4 transition ${societyCashBreakdownOpen ? "rotate-180" : ""}`} aria-hidden />
              </span>
            )}
          </button>
          {data.societyCashBreakdown && societyCashBreakdownOpen && (
            <div className="mt-3 rounded-2xl bg-paper-deep px-3 py-2 text-xs leading-relaxed text-muted">
              <span className="font-medium text-ink">(</span>
              <ul className="mt-1 space-y-1">
                {data.societyCashBreakdown.adds.map((row) => (
                  <li key={`+${row.name}`}>
                    <span className="text-moss">+</span> {row.name}: {formatINR(row.amount)}
                  </li>
                ))}
                {data.societyCashBreakdown.less.length > 0 &&
                  data.societyCashBreakdown.less.map((row) => (
                    <li key={`−${row.name}`}>
                      <span className="text-clay">−</span> {row.name}: {formatINR(row.amount)}
                    </li>
                  ))}
                {data.societyCashBreakdown.also?.map((row) => (
                  <li key={`·${row.name}`} className="text-muted">
                    {row.name}: {formatINR(row.amount)}
                  </li>
                ))}
                <li className="border-t border-line/60 pt-1 font-medium text-ink">
                  = {formatINR(data.societyCashBreakdown.total)}
                </li>
              </ul>
              <span className="font-medium text-ink">)</span>
            </div>
          )}
        </Card>
      </div>
      <Link to="/app/interest" className="block rounded-3xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-moss">
        <Card className="transition hover:bg-paper-deep">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-sm text-muted">Interest &amp; penalty pool</div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="num text-4xl">{formatINR(data.interest.combinedAvailable ?? data.interest.available)}</span>
                <span className="text-sm text-muted">
                  (interest {formatINR(data.interest.available)} · penalty {formatINR(data.interest.penaltyAvailable ?? "0.00")})
                </span>
              </div>
              <div className="text-sm text-muted">available to distribute</div>
            </div>
            <span className="text-sm font-medium text-moss">View pool →</span>
          </div>
        </Card>
      </Link>
      <ReopenPreviousCard />
    </Shell>
  );
}

export function AdminMembers() {
  const booksVersion = useBooksVersion();
  const [members, setMembers] = useState<MemberCard[] | null>(null);
  const [query, setQuery] = useState("");
  const [params] = useSearchParams();
  const [registerOpen, setRegisterOpen] = useState(true);
  const [importedRegister, setImportedRegister] = useState(false);
  const setup = members !== null && members.length === 0;
  const canAddMembers = members !== null && showAddMember(members.length, registerOpen);
  const [open, setOpen] = useState(params.get("new") === "1" && manualMembersAllowed());
  const [shareDefault, setShareDefault] = useState("500.00");
  const blankMember = () => ({ name: "", mobile: "", username: "", password: "", joiningDate: todayISO(), monthlyShare: shareDefault, reason: "New member approved by the society" });
  const [form, setForm] = useState(blankMember);
  const [error, setError] = useState("");
  async function load() {
    try {
      setMembers(await fetchMemberCards(booksVersion));
    } catch {
      setMembers([]);
    }
  }
  useEffect(() => {
    void load();
    fetchRegisterPolicy(booksVersion)
      .then((policy) => {
        setRegisterOpen(policy.canAddMembers);
        setImportedRegister(policy.importedRegister === true);
      })
      .catch(() => {
        setRegisterOpen(false);
        setImportedRegister(false);
      });
    api<{ defaultMonthlyShare: string }>("/api/settings").then((settings) => {
      setShareDefault(settings.defaultMonthlyShare);
      setForm((current) => (current.name ? current : { ...current, monthlyShare: settings.defaultMonthlyShare }));
    }).catch(() => undefined);
  }, [booksVersion]);

  useEffect(() => {
    if (members === null) return;
    if (!registerOpen) {
      setOpen(false);
      return;
    }
    if (params.get("new") !== "1") return;
    if (members.length > 0) {
      if (showAddMember(members.length, registerOpen)) setOpen(true);
      return;
    }
    allowManualMembers();
    setOpen(true);
  }, [members, params, registerOpen]);

  const memberUsernames = useMemo(
    () => new Set((members ?? []).map((row) => row.username?.trim().toLowerCase()).filter(Boolean)),
    [members],
  );
  const matchesQuery = (member: MemberCard) => member.name.toLowerCase().includes(query.toLowerCase());
  const activeMembers = (members ?? []).filter((member) => member.status === "ACTIVE" && matchesQuery(member));
  const inactiveMembers = (members ?? []).filter((member) => member.status === "INACTIVE" && matchesQuery(member));
  const anyShown = activeMembers.length + inactiveMembers.length > 0;

  function MemberRegisterCard({ member, inactive }: { member: MemberCard; inactive?: boolean }) {
    return (
      <Link to={`/app/members/${member.id}`} className="rounded-[28px] border border-line bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{member.name}</div>
            <div className="text-sm text-muted">@{member.username || "no login"} · #{member.memberNumber}</div>
          </div>
          {!inactive && (
            <div className="text-right">
              <div className="text-xs text-muted">Due</div>
              <Money value={member.totalDue} className="text-xl" />
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
          {inactive ? (
            <>
              <div><div className="text-muted">Shares</div><Money value={member.shareBalance} /></div>
              <div><div className="text-muted">Loan</div><Money value={member.loanOutstanding} /></div>
              <div><div className="text-muted">Interest bal.</div><Money value={member.interestBalance ?? "0.00"} /></div>
            </>
          ) : (
            <>
              <div><div className="text-muted">Loan</div><Money value={member.loanOutstanding} /></div>
              <div><div className="text-muted">Interest</div><Money value={member.currentInterest} /></div>
              <div><div className="text-muted">Principal</div><Money value={member.principalDue} /></div>
            </>
          )}
        </div>
      </Link>
    );
  }

  return (
    <Shell admin>
      <div className="flex items-end justify-between">
        <h1 className="text-3xl font-semibold">Members</h1>
        {canAddMembers && <Button onClick={() => setOpen(true)}>Add</Button>}
      </div>
      {members === null && <ListSkeleton count={5} />}
      {setup && (
        <RegisterSetupBanner onManual={() => setOpen(true)} />
      )}
      {members && members.length > 0 && !registerOpen && (
        <p className="text-sm text-muted">{addMembersBlockedMessage(importedRegister)}</p>
      )}
      {members && members.length > 0 && <Field label="Search" value={query} onChange={setQuery} placeholder="Name" />}
      {members && members.length > 0 && !anyShown && (
        <Empty title="No members found" body="No name matches that search." />
      )}
      {members && members.length > 0 && anyShown && (
        <div className="grid gap-8">
          <section className="grid gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-xl font-semibold">Active members</h2>
              <span className="text-sm text-muted">{activeMembers.length} on the books</span>
            </div>
            {activeMembers.length === 0 ? (
              <p className="text-sm text-muted">No active members match this search.</p>
            ) : (
              <div className="grid gap-3">
                {activeMembers.map((member) => (
                  <MemberRegisterCard key={member.id} member={member} />
                ))}
              </div>
            )}
          </section>
          <section className="grid gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-xl font-semibold">Inactive members</h2>
              <span className="text-sm text-muted">{inactiveMembers.length} left the society</span>
            </div>
            {inactiveMembers.length === 0 ? (
              <p className="text-sm text-muted">No inactive members{query ? " match this search" : ""}.</p>
            ) : (
              <div className="grid gap-3">
                {inactiveMembers.map((member) => (
                  <MemberRegisterCard key={member.id} member={member} inactive />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      <Sheet open={open} title="Add member" onClose={() => setOpen(false)}>
        <form className="grid gap-3" onSubmit={async (event) => {
          event.preventDefault();
          const phoneIssue = mobileError(form.mobile, true);
          if (phoneIssue) {
            setError(phoneIssue);
            return;
          }
          const login = form.username.trim();
          if (login.length < 3) {
            setError("Login username must be at least 3 characters.");
            return;
          }
          if (memberUsernames.has(login.toLowerCase())) {
            setError(`Username ${login} is already in use by another member.`);
            return;
          }
          try {
            if (!(await confirmMemberDistributionChange("add"))) return;
            await api("/api/members", {
              method: "POST",
              body: JSON.stringify({ ...form, username: login, mobile: normalizeMobile(form.mobile) ?? form.mobile }),
            });
            setForm(blankMember());
            setError("");
            setOpen(false);
            await load();
          } catch (err) { setError(err instanceof Error ? err.message : "Could not add member"); }
        }}>
          <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
          <Field label="Mobile" value={form.mobile} onChange={(mobile) => setForm({ ...form, mobile: mobileInput(mobile) })} inputMode="tel" placeholder="9876543210" />
          <p className="text-sm text-muted">10-digit Indian mobile, starting with 6, 7, 8 or 9.</p>
          <Field label="Login username" value={form.username} onChange={(username) => setForm({ ...form, username })} placeholder="Unique login name" />
          {form.username.trim().length >= 3 && memberUsernames.has(form.username.trim().toLowerCase()) && (
            <p className="text-sm text-clay">This username is already used by another member.</p>
          )}
          <Field label="Login password" type="password" value={form.password} onChange={(password) => setForm({ ...form, password })} />
          <Field label="Joining date" type="date" value={form.joiningDate} onChange={(joiningDate) => setForm({ ...form, joiningDate })} />
          <Field label="Monthly share" value={form.monthlyShare} onChange={(monthlyShare) => setForm({ ...form, monthlyShare })} />
          <p className="text-sm text-muted">Every member pays this basic share each month. The society default is {formatINR(shareDefault)}.</p>
          <Field label="Reason" value={form.reason} onChange={(reason) => setForm({ ...form, reason })} />
          {error && <p className="text-sm text-clay">{error}</p>}
          <Button type="submit">Save member</Button>
        </form>
      </Sheet>
    </Shell>
  );
}

export function AdminMember() {
  const { id = "" } = useParams();
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  useEffect(() => { api(`/api/members/${id}`).then(setData); }, [id, booksVersion]);
  if (!data) return <Shell admin><PageSkeleton /></Shell>;
  const latest = data.timeline.at(-1);
  return (
    <Shell admin>
      <div>
        <div className="text-sm text-muted">Member {data.member.memberNumber}</div>
        <h1 className="text-3xl font-semibold">{data.member.name}</h1>
        {data.member.username && <div className="mt-1 text-sm font-medium text-moss">Login @{data.member.username}</div>}
        <div className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${data.member.status === "ACTIVE" ? "bg-moss/10 text-moss" : "bg-clay/10 text-clay"}`}>
          {data.member.status === "ACTIVE" ? "Active" : "Inactive"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Card><Stat label="Total shares" value={data.member.shareBalance} /></Card>
        <Card><Stat label="Interest earned" value={data.member.interestEarned} /></Card>
        <Card><Stat label="Interest balance" value={data.member.interestBalance} /></Card>
        <Card><Stat label="Outstanding loan" value={data.member.loanOutstanding} /></Card>
      </div>
      {data.due && data.member.status === "ACTIVE" && (
        <Card>
          <div className="text-sm text-muted">{monthLabel(data.due.period)} still to collect</div>
          <Money value={data.due.totalDue} className="text-4xl" />
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-muted">
            {Object.entries(data.due.dues as Record<string, string>).map(([key, value]) => <span key={key}>{key.replaceAll("_", " ").toLowerCase()} {formatINR(value)}</span>)}
          </div>
          <Link to={`/app/pay?member=${data.member.id}`} className="mt-4 block"><Button full>Collect payment</Button></Link>
        </Card>
      )}
      <Card>
        <h2 className="mb-3 font-semibold">Month-wise history</h2>
        <p className="mb-3 text-sm text-muted">Every month for this member, oldest first.</p>
        <MemberHistoryTable
          rows={data.timeline}
          totals={data.timelineTotals}
          openPeriod={data.openPeriod}
          memberInactive={data.member.status === "INACTIVE"}
        />
      </Card>
      {latest && data.member.status === "ACTIVE" && (
        <p className="text-sm text-muted">Latest installment {formatINR(latest.total)} · shares on the statement {formatINR(latest.shares)}</p>
      )}
      <WhatsApp memberId={data.member.id} />
      <MemberLogin memberId={data.member.id} current={data.member.username ?? ""} onSaved={() => api(`/api/members/${id}`).then(setData)} />
      <MemberStatus
        member={data.member}
        booksVersion={booksVersion}
        onSaved={() => api(`/api/members/${id}`).then(setData)}
      />
    </Shell>
  );
}

const MEMBER_ACTIVATION_DISABLED_MESSAGE =
  "Member activation is not allowed in this release. Re-activating members will be available in the next phase as a premium feature.";

function MemberStatus({
  member,
  booksVersion,
  onSaved,
}: {
  member: { id: string; status: string; name: string };
  booksVersion: number;
  onSaved: () => void;
}) {
  const bumpBooks = useBumpBooks();
  const active = member.status === "ACTIVE";
  const [reason, setReason] = useState(active ? "Member left the society" : "Member rejoined the society");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deactivateBlocked, setDeactivateBlocked] = useState("");
  useEffect(() => {
    setReason(active ? "Member left the society" : "Member rejoined the society");
  }, [active]);
  useEffect(() => {
    if (!active) {
      setDeactivateBlocked("");
      return;
    }
    const params = new URLSearchParams({ action: "deactivate", memberId: member.id });
    api<{ blocked?: boolean; message: string }>(`/api/members/distribution-warning?${params}`)
      .then((warning) => setDeactivateBlocked(warning.blocked && warning.message ? warning.message : ""))
      .catch(() => setDeactivateBlocked(""));
  }, [active, member.id, booksVersion]);
  return (
    <Card>
      <h2 className="font-semibold">Active or inactive</h2>
      <p className="mt-1 text-sm text-muted">
        {active
          ? "This member can pay and sign in. Deactivate only after their loan is cleared and they have no receipt in the open month — share capital and interest wallet are paid out in cash. Month sheets show 0 share/loan for inactive members after exit."
          : "This member is inactive — they cannot pay or sign in. Society reports for closed months stay as saved."}
      </p>
      {!active && (
        <p className="mt-2 rounded-2xl border border-line bg-paper-deep px-3 py-2 text-sm text-muted">
          {MEMBER_ACTIVATION_DISABLED_MESSAGE}
        </p>
      )}
      {deactivateBlocked && (
        <p className="mt-2 text-sm text-clay">{deactivateBlocked}</p>
      )}
      <form className="mt-3 grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        if (!active) return;
        setError("");
        setBusy(true);
        try {
          const ok = await confirmMemberDistributionChange("deactivate", member.id);
          if (!ok) return;
          await api(`/api/members/${member.id}/deactivate`, { method: "POST", body: JSON.stringify({ reason }) });
          bumpBooks();
          onSaved();
        } catch (err) { setError(err instanceof Error ? err.message : "Could not update the member"); }
        finally { setBusy(false); }
      }}>
        {active && <Field label="Reason" value={reason} onChange={setReason} />}
        {error && <p className="text-sm text-clay">{error}</p>}
        <Button
          type={active ? "submit" : "button"}
          tone={active ? "danger" : "primary"}
          disabled={busy || Boolean(deactivateBlocked) || !active}
        >
          {active ? "Deactivate member" : "Activate member"}
        </Button>
      </form>
    </Card>
  );
}

function MemberLogin({ memberId, current, onSaved }: { memberId: string; current: string; onSaved: () => void }) {
  const [username, setUsername] = useState(current);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("Login issued by the society admin");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setUsername(current), [current]);
  return (
    <Card>
      <h2 className="font-semibold">Member login</h2>
      <p className="mt-1 text-sm text-muted">The member can sign in and view their account. They cannot change society records.</p>
      <form className="mt-3 grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        setMessage("");
        try {
          await api(`/api/members/${memberId}/login`, { method: "POST", body: JSON.stringify({ username, password: password || undefined, reason }) });
          setPassword("");
          setMessage("Login saved. Share the username and password with the member.");
          onSaved();
        } catch (err) { setError(err instanceof Error ? err.message : "Could not save the login"); }
      }}>
        <Field label="Username" value={username} onChange={setUsername} />
        <Field label="New password" type="password" value={password} onChange={setPassword} placeholder="Leave blank to keep the current password" />
        <Field label="Reason" value={reason} onChange={setReason} />
        {error && <p className="text-sm text-clay">{error}</p>}
        {message && <p className="text-sm text-moss">{message}</p>}
        <Button type="submit">Save login</Button>
      </form>
    </Card>
  );
}

function WhatsApp({ memberId }: { memberId: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  async function draft(kind: string) {
    const result = await api<{ text: string }>(`/api/members/${memberId}/whatsapp?kind=${kind}`);
    setText(result.text);
    setOpen(true);
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button tone="ghost" onClick={() => draft("reminder")}>Reminder</Button>
        <Button tone="ghost" onClick={() => draft("statement")}>Statement</Button>
        <Button tone="ghost" onClick={() => draft("receipt")}>Receipt</Button>
        <Button tone="ghost" onClick={() => draft("distribution")}>Interest note</Button>
      </div>
      <Sheet open={open} title="Send on WhatsApp" onClose={() => setOpen(false)}>
        <p className="whitespace-pre-wrap text-sm leading-6">{text}</p>
        <p className="my-3 text-sm text-muted">Nothing is sent until you press send in WhatsApp.</p>
        <Button full onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank")}>Open WhatsApp</Button>
      </Sheet>
    </>
  );
}

type Receipt = { id: string; receiptNo: string; member: string; amount: string; paidOn: string; period: string; canDelete?: boolean; allocations: { component: string; amount: string }[] };

const COMPONENT_LABELS: Record<string, string> = {
  SHARE: "share",
  PREVIOUS_INTEREST: "pending from last month",
  CURRENT_INTEREST: "interest",
  PRINCIPAL: "principal",
  PENALTY: "penalty",
};

function groupByPeriod(rows: Receipt[], totals: Map<string, MonthSummary>) {
  const months = new Map<string, Receipt[]>();
  for (const row of rows) {
    months.set(row.period, [...(months.get(row.period) ?? []), row]);
  }
  return [...months.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([period, receipts]) => ({
      period,
      receipts,
      total: totals.get(period)?.total ?? fromPaise(receipts.reduce((sum, row) => sum + paise(row.amount), 0)),
    }));
}

type MonthSummary = { period: string; receipts: number; total: string };

export function AdminPayments() {
  const booksVersion = useBooksVersion();
  const bumpBooks = useBumpBooks();
  const loadSeq = useRef(0);
  const [rows, setRows] = useState<Receipt[]>([]);
  const [months, setMonths] = useState<MonthSummary[]>([]);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState("");
  const [downloading, setDownloading] = useState("");
  async function loadMonths(preferred?: string) {
    const seq = ++loadSeq.current;
    const list = await api<MonthSummary[]>("/api/payments/months");
    if (seq !== loadSeq.current) return list;
    setMonths(list);
    setMonth((current) => {
      const next = preferred ?? current;
      if (next === "all") return "all";
      if (next && list.some((row) => row.period === next)) return next;
      return list[0]?.period || "";
    });
    if (list.length === 0) setLoading(false);
    return list;
  }
  async function loadReceipts(selected: string) {
    if (!selected) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const list = await api<Receipt[]>(`/api/payments${selected === "all" ? "" : `?period=${selected}`}`);
      if (seq !== loadSeq.current) return;
      setRows(list);
      setError("");
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setRows([]);
      setError(err instanceof Error ? err.message : "Receipts could not be loaded.");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }
  useEffect(() => {
    loadMonths().catch((err) => {
      setMonths([]);
      setLoading(false);
      setError(err instanceof Error ? err.message : "Receipts could not be loaded.");
    });
  }, [booksVersion]);
  useEffect(() => {
    if (!month) return;
    loadReceipts(month);
  }, [month, booksVersion]);
  const totals = new Map(months.map((row) => [row.period, row]));
  const shown = groupByPeriod(rows, totals);
  return (
    <Shell admin>
      <div className="flex items-center justify-between"><h1 className="text-3xl font-semibold">Payments</h1><Link to="/app/pay"><Button>Collect</Button></Link></div>
      <p className="text-sm text-muted">A mistaken receipt can be removed only while the month is still open, before you close it. The member's due comes back so you can collect the correct amount.</p>
      {months.length > 0 && (
        <select className="min-h-12 w-full rounded-2xl border border-line bg-white px-3" value={month} onChange={(event) => setMonth(event.target.value)}>
          {months.map((row) => <option key={row.period} value={row.period}>{monthLabel(row.period)} · {row.receipts} {row.receipts === 1 ? "receipt" : "receipts"}</option>)}
          <option value="all">All months</option>
        </select>
      )}
      {error && <p className="text-sm text-clay">{error}</p>}
      {loading && <ListSkeleton count={4} />}
      {!loading && months.length === 0 && !error && (
        <Empty
          title="No receipts found"
          body="This month's installment is still open. Collect a payment and the receipt appears here."
          action={<Link to="/app/pay"><Button>Collect</Button></Link>}
        />
      )}
      {!loading && shown.map((group) => (
        <section key={group.period} className="grid gap-2">
          <div className="flex items-baseline justify-between gap-3 px-1">
            <h2 className="text-lg font-semibold">{monthLabel(group.period)}</h2>
            <div className="text-sm text-muted">{group.receipts.length} {group.receipts.length === 1 ? "receipt" : "receipts"} · <Money value={group.total} /></div>
          </div>
          {group.receipts.map((row) => (
            <Card
              key={row.id}
              className="cursor-pointer transition hover:bg-paper-deep"
              role="button"
              tabIndex={0}
              onClick={() => {
                if (downloading === row.id) return;
                setDownloading(row.id);
                setError("");
                downloadPaymentReceipt(row.id, row.receiptNo)
                  .catch((err) => setError(err instanceof Error ? err.message : "Could not download receipt"))
                  .finally(() => setDownloading(""));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  (event.currentTarget as HTMLElement).click();
                }
              }}
            >
              <div className="flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold">{row.member}</div>
                  <div className="text-sm text-muted">{row.receiptNo} · {new Date(row.paidOn).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</div>
                  <div className="mt-1 text-xs text-moss">{downloading === row.id ? "Preparing PDF…" : "Tap to download receipt"}</div>
                </div>
                <Money value={row.amount} className="text-2xl" />
              </div>
              <div className="mt-2 text-sm text-muted">
                {row.allocations.filter((item) => item.amount !== "0.00").map((item) => `${COMPONENT_LABELS[item.component] ?? item.component} ${formatINR(item.amount)}`).join(" · ")}
              </div>
              {row.canDelete && (
                <Button
                  tone="danger"
                  className="mt-3"
                  disabled={removing === row.id}
                  onClick={async (event) => {
                    event.stopPropagation();
                    if (!window.confirm(`Remove ${row.receiptNo} for ${row.member}? Their due comes back and you can collect again.`)) return;
                    setRemoving(row.id);
                    setError("");
                    try {
                      await api(`/api/payments/${row.id}/delete`, { method: "POST", body: JSON.stringify({ reason: "Entered by mistake" }) });
                      bumpBooks();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "This receipt could not be removed.");
                    } finally {
                      setRemoving("");
                    }
                  }}
                >
                  {removing === row.id ? "Removing…" : "Delete"}
                </Button>
              )}
            </Card>
          ))}
        </section>
      ))}
    </Shell>
  );
}

function moneyPayload(value: string) {
  const match = value.replace(/[^\d.]/g, "").match(/^(\d+)(?:\.(\d{0,2}))?/);
  if (!match) return "";
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function paise(value: string) {
  const [whole, frac = "00"] = (value || "0").replace(/[^\d.]/g, "").split(".");
  return Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
}

function fromPaise(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function dueParts(member: MemberCard) {
  const share = member.shareDue ?? member.monthlyShare ?? "0.00";
  const interest = member.interestDue ?? member.currentInterest ?? "0.00";
  const pending = member.previousPending ?? "0.00";
  const penalty = member.penaltyDue ?? "0.00";
  const due = fromPaise(paise(share) + paise(interest) + paise(pending));
  return { share, interest, pending, penalty, due };
}

function scheduledPrincipalFill(member: MemberCard) {
  const dueThisMonth = member.principalDue ?? member.scheduledPrincipal ?? "0.00";
  return fromPaise(Math.min(paise(dueThisMonth), paise(member.loanOutstanding)));
}

/** Still on the collect list: no receipt recorded for the open month yet. */
function awaitingCollect(member: MemberCard, alsoCollected: Set<string>) {
  if (alsoCollected.has(member.id)) return false;
  return !member.collectedThisOpenMonth;
}

export function AdminPay() {
  const booksVersion = useBooksVersion();
  const bumpBooks = useBumpBooks();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [members, setMembers] = useState<MemberCard[] | null>(null);
  const [memberId, setMemberId] = useState(params.get("member") ?? "");
  const [paying, setPaying] = useState("");
  const [principal, setPrincipal] = useState("");
  const [reason, setReason] = useState("Monthly meeting collection");
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [penalty, setPenalty] = useState(params.get("penalty") === "1");
  const [penaltyAmount, setPenaltyAmount] = useState("100.00");
  const [receivePenalty, setReceivePenalty] = useState(false);
  const [penaltyReceived, setPenaltyReceived] = useState("");
  const [nextMonthPenalty, setNextMonthPenalty] = useState(false);
  const [nextMonthPenaltyAmount, setNextMonthPenaltyAmount] = useState("100.00");
  const [useScheduledPrincipal, setUseScheduledPrincipal] = useState(false);
  const [query, setQuery] = useState("");
  /** Hide immediately after Confirm, before members refetch. */
  const [collectedNow, setCollectedNow] = useState<Set<string>>(() => new Set());
  const [registerOpen, setRegisterOpen] = useState(true);
  const [importedRegister, setImportedRegister] = useState(false);
  useEffect(() => {
    fetchMemberCards(booksVersion).then(setMembers).catch(() => {
      setMembers([]);
      setError("Members could not be loaded. Open this page again.");
    });
    fetchRegisterPolicy(booksVersion)
      .then((policy) => {
        setRegisterOpen(policy.canAddMembers);
        setImportedRegister(policy.importedRegister === true);
      })
      .catch(() => setRegisterOpen(false));
  }, [booksVersion]);
  const member = (members ?? []).find((row) => row.id === memberId);
  const search = query.trim().toLowerCase();
  const shortlist = (members ?? []).filter((row) => {
    if (row.status !== "ACTIVE") return false;
    if (!penalty && !awaitingCollect(row, collectedNow)) return false;
    if (search !== "" && !row.name.toLowerCase().includes(search)) return false;
    return true;
  });
  const parts = member ? dueParts(member) : null;
  const payingAmount = paying.trim() === "" ? "0.00" : moneyPayload(paying) || "0.00";
  const principalAmount = member && paise(member.loanOutstanding) > 0 && principal.trim() !== "" ? moneyPayload(principal) : "0.00";
  const receiveAmount = receivePenalty && parts && paise(parts.penalty) > 0
    ? (() => {
      const typed = penaltyReceived.trim() === "" ? parts.penalty : moneyPayload(penaltyReceived) || "0.00";
      return paise(typed) > paise(parts.penalty) ? parts.penalty : typed;
    })()
    : "0.00";
  const carry = parts ? fromPaise(Math.max(0, paise(parts.due) - paise(payingAmount))) : "0.00";
  const unpaidPrincipal = member
    ? fromPaise(Math.max(0, paise(member.principalDue) - paise(principalAmount || "0.00")))
    : "0.00";
  const shortOnInstallment = paise(carry) > 0 || paise(unpaidPrincipal) > 0;
  const deferPenalty = nextMonthPenalty && shortOnInstallment ? moneyPayload(nextMonthPenaltyAmount) || "0.00" : "0.00";
  const collecting = fromPaise(paise(payingAmount) + paise(principalAmount || "0.00") + paise(receiveAmount));
  const amountFor = useRef("");
  useEffect(() => {
    if (!member || amountFor.current === member.id) return;
    amountFor.current = member.id;
    const due = dueParts(member).due;
    setPaying(due === "0.00" ? "" : due);
    setPrincipal("");
    setUseScheduledPrincipal(false);
    setReceivePenalty(false);
    setPenaltyReceived("");
    setNextMonthPenalty(false);
    setNextMonthPenaltyAmount("100.00");
    setPreview(null);
    setNotice("");
  }, [member]);
  const [period, setPeriod] = useState("");
  useEffect(() => { fetchOpenPeriod(booksVersion).then((row) => setPeriod(row.period)).catch(() => undefined); }, [booksVersion]);
  return (
    <Shell admin>
      <h1 className="text-3xl font-semibold">{penalty ? "Add penalty" : "Collect payment"}</h1>
      {members && members.length === 0 && error && (
        <Empty title="Members could not be loaded" body={error} />
      )}
      {members && members.length === 0 && !error && (
        registerNeedsSetup(members.length) ? (
          <RegisterSetupBanner />
        ) : showAddMember(members.length, registerOpen) ? (
          <Empty
            title="No members found"
            body="Add a member before collecting a payment or adding a penalty."
            action={<Link to="/app/members?new=1"><Button>Add</Button></Link>}
          />
        ) : (
          <Empty title="No members found" body={addMembersBlockedMessage(importedRegister)} />
        )
      )}
      {member ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-moss bg-white px-4 py-3">
          <div>
            <div className="font-medium">{member.name}</div>
            <div className="text-sm text-muted">Due {formatINR(dueParts(member).due)}</div>
          </div>
          <button type="button" className="min-h-10 shrink-0 rounded-2xl border border-line px-3 text-sm font-semibold" onClick={() => { setMemberId(""); setQuery(""); setPreview(null); setNotice(""); setError(""); }}>Change</button>
        </div>
      ) : members && members.length === 0 ? null : (
        <div className="grid gap-2">
          <Field label="Find a member" value={query} onChange={setQuery} placeholder="Type a name" />
          <div className="grid max-h-72 gap-2 overflow-auto">
            {members === null && <ListSkeleton count={4} />}
            {shortlist.map((row) => (
              <button key={row.id} type="button" onClick={() => { setMemberId(row.id); setPaying(dueParts(row).due === "0.00" ? "" : dueParts(row).due); setPrincipal(""); setUseScheduledPrincipal(false); setReceivePenalty(false); setNextMonthPenalty(false); setPreview(null); }} className="rounded-2xl border border-line bg-card px-4 py-3 text-left">
                <div className="font-medium">{row.name}</div>
                <div className="text-sm text-muted">Due {formatINR(dueParts(row).due)}</div>
              </button>
            ))}
            {members && shortlist.length === 0 && (
              <Empty
                title={penalty ? "No members found" : search ? "No members found" : "All caught up"}
                body={
                  penalty || search
                    ? "No active member matches that name."
                    : "Every active member already has a receipt this month. Open Payments to review, or collect again from the member page."
                }
              />
            )}
          </div>
        </div>
      )}
      {member && member.status !== "ACTIVE" && <Card><p>This member has left the society, so there is no installment to collect this month.</p></Card>}
      {member && member.status === "ACTIVE" && !penalty && (
        <Card>
          {parts && (
            <div className="grid gap-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-muted">Monthly share</div>
                  <div className="text-xs text-muted">{paise(parts.share) === 0 && paise(member.monthlyShare) > 0 ? `${formatINR(member.monthlyShare)} already collected this month` : `${rupeesInWords(member.monthlyShare)} each month`}</div>
                </div>
                <div className="text-right">
                  <div className="num text-lg">{formatINR(parts.share)}</div>
                  <div className="text-xs text-muted">{rupeesInWords(parts.share)} still to collect</div>
                </div>
              </div>
              {paise(member.loanOutstanding) > 0 && (
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm text-muted">Interest on the loan</div>
                    <div className="text-xs text-muted">This month, on {formatINR(member.loanOutstanding)} outstanding</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-lg">{formatINR(parts.interest)}</div>
                    <div className="text-xs text-muted">{rupeesInWords(parts.interest)}</div>
                  </div>
                </div>
              )}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-muted">Pending from last month</div>
                  <div className="text-xs text-muted">Unpaid share or interest from last month</div>
                </div>
                <div className="text-right">
                  <div className="num text-lg">{formatINR(parts.pending)}</div>
                  <div className="text-xs text-muted">{rupeesInWords(parts.pending)}</div>
                </div>
              </div>
              {paise(parts.penalty) > 0 && (
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm text-muted">Penalty due</div>
                    <div className="text-xs text-muted">Unpaid penalty plus any next-month fee added last time. What is not received stays due next month.</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-lg">{formatINR(parts.penalty)}</div>
                    <div className="text-xs text-muted">{rupeesInWords(parts.penalty)}</div>
                  </div>
                </div>
              )}
              <div className="border-t border-line pt-3">
                <Field label="Due now" value={paying} onChange={(value) => { setPaying(value.replace(/[^\d.]/g, "")); setPreview(null); setNotice(""); }} inputMode="decimal" selectOnFocus placeholder="0.00" />
                <p className="mt-1 text-sm text-muted">Full due is {formatINR(parts.due)}, {rupeesInWords(parts.due).toLowerCase()}. Type 0 to record a ₹0 receipt. {paise(carry) > 0 ? `${formatINR(carry)}, ${rupeesInWords(carry).toLowerCase()}, will be added next month.` : "The full due is being paid."}</p>
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-3">
            {paise(member.loanOutstanding) > 0 && paise(scheduledPrincipalFill(member)) > 0 && (
              <button
                type="button"
                onClick={() => {
                  const next = !useScheduledPrincipal;
                  setUseScheduledPrincipal(next);
                  setPrincipal(next ? scheduledPrincipalFill(member) : "");
                  setPreview(null);
                }}
                className={`flex min-h-14 items-start justify-between gap-4 rounded-2xl border px-4 py-3 text-left ${useScheduledPrincipal ? "border-moss bg-white" : "border-line bg-paper"}`}
              >
                <div>
                  <div className="font-medium">Scheduled principal</div>
                  <div className="text-xs text-muted">Fill {formatINR(scheduledPrincipalFill(member))}, this month's principal on the sheet. A new loan or a changed schedule starts next month. Leave unchecked to type any amount.</div>
                </div>
                <span className={`mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md border text-sm ${useScheduledPrincipal ? "border-moss bg-moss text-white" : "border-line bg-white text-transparent"}`}>✓</span>
              </button>
            )}
            {paise(member.loanOutstanding) > 0 ? (
              <Field label="Principal to repay" value={principal} onChange={(value) => {
                const next = value.replace(/[^\d.]/g, "");
                setPrincipal(next);
                const filled = scheduledPrincipalFill(member);
                setUseScheduledPrincipal(paise(filled) > 0 && (moneyPayload(next) || "0.00") === filled);
                setPreview(null);
              }} inputMode="decimal" selectOnFocus placeholder="0.00" />
            ) : (
              <Field label="Principal to repay" value="0.00" onChange={() => undefined} disabled title="No loan" />
            )}
            <p className="text-xs text-muted">{paise(member.loanOutstanding) > 0 ? `Loan left ${formatINR(member.loanOutstanding)}. Type any principal they are repaying today.` : "No loan"}</p>
          </div>
          <div className="mt-4 grid gap-3">
            {parts && paise(parts.penalty) > 0 && (
              <div className={`rounded-2xl border px-4 py-3 ${receivePenalty ? "border-moss bg-white" : "border-line bg-paper"}`}>
                <button
                  type="button"
                  onClick={() => {
                    const next = !receivePenalty;
                    setReceivePenalty(next);
                    setPenaltyReceived(next ? parts.penalty : "");
                    setPreview(null);
                    setNotice("");
                  }}
                  className="flex w-full min-h-12 items-start justify-between gap-4 text-left"
                >
                  <div>
                    <div className="font-medium">Receive penalty</div>
                    <div className="text-xs text-muted">Collect some or all of {formatINR(parts.penalty)}. What you do not take stays due next month. Collected penalty joins the interest &amp; penalty pool when you distribute.</div>
                  </div>
                  <span className={`mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md border text-sm ${receivePenalty ? "border-moss bg-moss text-white" : "border-line bg-white text-transparent"}`}>✓</span>
                </button>
                {receivePenalty && (
                  <div className="mt-3">
                    <Field label="Penalty received today" value={penaltyReceived} onChange={(value) => { setPenaltyReceived(value.replace(/[^\d.]/g, "")); setPreview(null); }} inputMode="decimal" selectOnFocus placeholder="0.00" />
                    {paise(parts.penalty) > paise(receiveAmount) && (
                      <p className="mt-1 text-xs text-muted">{formatINR(fromPaise(paise(parts.penalty) - paise(receiveAmount)))} remains and will be due next month.</p>
                    )}
                  </div>
                )}
              </div>
            )}
            {shortOnInstallment && (
              <div className={`rounded-2xl border px-4 py-3 ${nextMonthPenalty ? "border-moss bg-white" : "border-line bg-paper"}`}>
                <button
                  type="button"
                  onClick={() => { setNextMonthPenalty((current) => !current); setPreview(null); setNotice(""); }}
                  className="flex w-full min-h-12 items-start justify-between gap-4 text-left"
                >
                  <div>
                    <div className="font-medium">Next month penalty</div>
                    <div className="text-xs text-muted">
                      {paise(carry) > 0 && paise(unpaidPrincipal) > 0
                        ? "Due or principal is not being paid in full. Add a late fee now. It is not collected today and will be due next month."
                        : paise(unpaidPrincipal) > 0
                          ? "This month’s principal is not being paid in full. Add a late fee now. It is not collected today and will be due next month."
                          : "They are not paying the full due. Add a late fee now. It is not collected today and will be due next month."}
                    </div>
                  </div>
                  <span className={`mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md border text-sm ${nextMonthPenalty ? "border-moss bg-moss text-white" : "border-line bg-white text-transparent"}`}>✓</span>
                </button>
                {nextMonthPenalty && (
                  <div className="mt-3">
                    <Field label="Penalty for next month" value={nextMonthPenaltyAmount} onChange={(value) => { setNextMonthPenaltyAmount(value.replace(/[^\d.]/g, "")); setPreview(null); }} inputMode="decimal" selectOnFocus placeholder="0.00" />
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="mt-4 rounded-2xl bg-paper p-4">
            <div className="text-sm text-muted">Whole amount to collect</div>
            <div className="num text-3xl">{formatINR(collecting)}</div>
            <div className="mt-1 text-sm">{rupeesInWords(collecting)}</div>
            <p className="mt-2 text-sm text-muted">
              {formatINR(payingAmount)} due
              {paise(principalAmount || "0.00") > 0 ? ` + ${formatINR(principalAmount)} principal` : ""}
              {paise(receiveAmount) > 0 ? ` + ${formatINR(receiveAmount)} penalty received` : ""}
              {paise(principalAmount || "0.00") > 0 || paise(receiveAmount) > 0 ? ` = ${formatINR(collecting)}` : ""}
              {paise(carry) > 0 ? ` · ${formatINR(carry)} due added next month` : ""}
              {paise(unpaidPrincipal) > 0 ? ` · ${formatINR(unpaidPrincipal)} principal still due` : ""}
              {paise(deferPenalty) > 0 ? ` · ${formatINR(deferPenalty)} next-month penalty, not collected today` : ""}
            </p>
          </div>
          <div className="mt-3"><Field label="Reason" value={reason} onChange={setReason} /></div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button tone="ghost" loading={previewLoading} disabled={!period} onClick={async () => {
              setPreviewLoading(true);
              setError("");
              try {
                setPreview(await api("/api/payments/preview", { method: "POST", body: JSON.stringify({
                  memberId,
                  period,
                  amount: collecting,
                  ...(paise(receiveAmount) > 0 ? { collectPenalty: true, collectPenaltyAmount: receiveAmount } : {}),
                  ...(paise(deferPenalty) > 0 ? { nextMonthPenalty: deferPenalty } : {}),
                }) }));
                setNotice(collecting === "0.00" ? "₹0 receipt. No cash is taken. Unpaid due still goes to next month." : "");
              }
              catch (err) { setPreview(null); setError(err instanceof Error ? err.message : "Preview failed"); }
              finally { setPreviewLoading(false); }
            }}>Preview split</Button>
            <Button loading={confirmLoading} disabled={!period} onClick={async () => {
              setConfirmLoading(true);
              setError("");
              try {
                await api("/api/payments", { method: "POST", body: JSON.stringify({
                  memberId,
                  period,
                  amount: collecting,
                  paidOn: todayISO(),
                  reason: collecting === "0.00" ? `${reason} Marked collected at ₹0.` : reason,
                  idempotencyKey: newId(),
                  ...(paise(receiveAmount) > 0 ? { collectPenalty: true, collectPenaltyAmount: receiveAmount } : {}),
                  ...(paise(deferPenalty) > 0 ? { nextMonthPenalty: deferPenalty } : {}),
                }) });
                setCollectedNow((prev) => new Set(prev).add(memberId));
                bumpBooks();
                navigate("/app/payments");
              } catch (err) { setError(err instanceof Error ? err.message : "Payment failed"); }
              finally { setConfirmLoading(false); }
            }}>Confirm</Button>
          </div>
          {previewLoading && <ListSkeleton count={2} />}
          {!previewLoading && preview && (
            <div className="mt-4 grid gap-1 text-sm">
              {preview.allocation.filter((row: { amount: string }) => row.amount !== "0.00").map((row: { component: string; amount: string }) => (
                <div key={row.component} className="flex justify-between">
                  <span>{{ SHARE: "Monthly share", PREVIOUS_INTEREST: "Pending from last month", CURRENT_INTEREST: "Interest on the loan", PRINCIPAL: "Principal repaid", PENALTY: "Penalty received" }[row.component] ?? row.component}</span>
                  <Money value={row.amount} />
                </div>
              ))}
              {preview.nextMonthPenalty && preview.nextMonthPenalty !== "0.00" && (
                <div className="flex justify-between text-muted">
                  <span>Next month penalty</span>
                  <Money value={preview.nextMonthPenalty} />
                </div>
              )}
            </div>
          )}
          {notice && <p className="mt-3 text-sm text-moss">{notice}</p>}
          {error && <p className="mt-3 text-sm text-clay">{error}</p>}
        </Card>
      )}
      {member && member.status === "ACTIVE" && penalty && (
        <Card>
          <Field label="Penalty" value={penaltyAmount} onChange={(value) => setPenaltyAmount(value.replace(/[^\d.]/g, ""))} inputMode="decimal" selectOnFocus placeholder="0.00" />
          <div className="mt-3"><Field label="Reason" value={reason} onChange={setReason} /></div>
          <Button full className="mt-3" disabled={!period} onClick={async () => {
            try {
              await api("/api/penalties", { method: "POST", body: JSON.stringify({ memberId, period, amount: moneyPayload(penaltyAmount), date: todayISO(), reason }) });
              bumpBooks();
              navigate(`/app/members/${memberId}`);
            } catch (err) { setError(err instanceof Error ? err.message : "Could not add penalty"); }
          }}>Save penalty</Button>
          {error && <p className="mt-3 text-sm text-clay">{error}</p>}
        </Card>
      )}
    </Shell>
  );
}

type LoanGiven = { id: string; date: string; period: string; month: string; member: string; amount: string; opening: boolean };

type LoanHistoryResponse = { years: string[]; periods: string[]; rows: LoanGiven[] };

/** Older API builds returned a bare array; newer ones return { years, periods, rows }. */
function normalizeLoanHistoryResponse(
  data: LoanHistoryResponse | LoanGiven[],
  year: string,
  period: string,
): LoanHistoryResponse {
  if (!Array.isArray(data)) return data;
  const years = [...new Set(data.map((row) => row.period.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const periods = [...new Set(data.map((row) => row.period))].sort((a, b) => b.localeCompare(a));
  let rows = data;
  if (period) rows = data.filter((row) => row.period === period);
  else rows = data.filter((row) => row.period.startsWith(`${year}-`));
  return { years, periods, rows };
}

function loanGivenOn(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function currentCalendarYear() {
  return String(new Date().getFullYear());
}

function validateDisburseLoan(form: {
  memberId: string;
  amount: string;
  date: string;
  scheduledPrincipal: string;
  reason: string;
}, cashInHand: string) {
  if (!form.memberId.trim()) return "Please select a member.";
  if (!/^\d+(\.\d{1,2})?$/.test(form.amount.trim())) return "Enter a valid loan amount, such as 10000 or 10000.00.";
  if (Number(form.amount) <= 0) return "Loan amount must be greater than zero.";
  if (Number(form.amount) > Number(cashInHand)) return `The society has ${formatINR(cashInHand)} in hand. The loan cannot be more than that.`;
  if (!/^\d+(\.\d{1,2})?$/.test(form.scheduledPrincipal.trim())) return "Enter a valid scheduled principal, such as 1000 or 1000.00.";
  if (Number(form.scheduledPrincipal) <= 0) return "Scheduled principal must be greater than zero.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return "Choose a valid loan date.";
  if (form.reason.trim().length < 3) return "Enter a reason (at least 3 characters).";
  return "";
}

export function AdminLoans() {
  const booksVersion = useBooksVersion();
  const bumpBooks = useBumpBooks();
  const [loans, setLoans] = useState<any[] | null>(null);
  const [history, setHistory] = useState<LoanGiven[]>([]);
  const [historyYears, setHistoryYears] = useState<string[]>([]);
  const [historyPeriods, setHistoryPeriods] = useState<string[]>([]);
  const [historyYear, setHistoryYear] = useState(currentCalendarYear);
  const [historyPeriod, setHistoryPeriod] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [members, setMembers] = useState<MemberCard[]>([]);
  const [cash, setCash] = useState("0.00");
  const [params] = useSearchParams();
  const [open, setOpen] = useState(params.get("new") === "1");
  const [form, setForm] = useState({ memberId: "", amount: "10000.00", date: todayISO(), scheduledPrincipal: "1000.00", purpose: "", reason: "Loan approved by the society" });
  const [error, setError] = useState("");
  async function loadHistory(year: string, period: string) {
    setHistoryLoading(true);
    try {
      const query = period ? `?period=${encodeURIComponent(period)}` : `?year=${encodeURIComponent(year)}`;
      const raw = await api<LoanHistoryResponse | LoanGiven[]>(`/api/loans/history${query}`);
      const data = normalizeLoanHistoryResponse(raw, year, period);
      setHistory(data.rows);
      const years = data.years.length > 0 ? data.years : [year];
      if (!years.includes(year)) years.push(year);
      years.sort((a, b) => b.localeCompare(a));
      setHistoryYears(years);
      setHistoryPeriods(data.periods);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }
  async function load() {
    try {
      const [loanRows, memberRows, dashboard] = await Promise.all([
        api<any[]>("/api/loans"),
        fetchMemberCards(booksVersion),
        api<{ societyCash: string; societyCashLedger?: string }>("/api/dashboard"),
      ]);
      setLoans(loanRows);
      setMembers(memberRows);
      setCash(dashboard.societyCashLedger ?? dashboard.societyCash);
      setError("");
    } catch (err) {
      setLoans([]);
      setHistory([]);
      setError(err instanceof Error ? err.message : "Could not load loans");
    }
  }
  useEffect(() => { void load(); }, [booksVersion]);
  useEffect(() => {
    void loadHistory(historyYear, historyPeriod);
  }, [booksVersion, historyYear, historyPeriod]);
  const yearOptions = [...new Set([currentCalendarYear(), ...historyYears])].sort((a, b) => b.localeCompare(a));
  const monthOptions = historyPeriods.filter((period) => period.startsWith(`${historyYear}-`));
  return (
    <Shell admin>
      <div className="flex items-center justify-between"><h1 className="text-3xl font-semibold">Loans</h1><Button onClick={() => setOpen(true)}>New loan</Button></div>
      {loans === null && <ListSkeleton count={4} />}
      {loans && loans.length === 0 && history.length === 0 && !historyLoading && historyPeriods.length === 0 && (
        <Empty
          title="No loans found"
          body="Disburse a loan after members are on the register. It cannot be more than society cash in hand."
          action={<Button onClick={() => setOpen(true)}>New loan</Button>}
        />
      )}
      {loans && (loans.length > 0 || history.length > 0 || historyPeriods.length > 0 || historyLoading) && (
        <>
      <h2 className="text-xl font-semibold">Outstanding loans</h2>
      {loans.length === 0 && <p className="text-sm text-muted">No loan is outstanding. Earlier loans stay in the history below.</p>}
      {loans.length > 0 && (
        <>
      <div className="hidden overflow-hidden rounded-[28px] border border-line bg-card lg:block">
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="p-4">Member</th><th>Outstanding</th><th>Status</th></tr></thead>
          <tbody>{loans.map((loan) => <tr key={loan.id} className="border-t border-line"><td className="p-4">{loan.member}</td><td><Money value={loan.outstandingPrincipal} /></td><td>{loan.status.replaceAll("_", " ")}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="grid gap-3 lg:hidden">
        {loans.map((loan) => <Card key={loan.id}><div className="font-semibold">{loan.member}</div><div className="mt-2"><Money value={loan.outstandingPrincipal} className="text-2xl" /></div><div className="text-sm text-muted">{loan.status.replaceAll("_", " ")}</div></Card>)}
      </div>
        </>
      )}
      <h2 className="mt-6 text-xl font-semibold">Loan history</h2>
      <p className="text-sm text-muted">Every loan given, with the date and amount. A further loan to the same member is listed as its own line.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Year</span>
          <select
            className="min-h-12 w-full rounded-2xl border border-line bg-white px-3"
            value={historyYear}
            onChange={(event) => {
              setHistoryYear(event.target.value);
              setHistoryPeriod("");
            }}
          >
            {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Month</span>
          <select
            className="min-h-12 w-full rounded-2xl border border-line bg-white px-3"
            value={historyPeriod}
            onChange={(event) => setHistoryPeriod(event.target.value)}
          >
            <option value="">All months in {historyYear}</option>
            {monthOptions.map((period) => <option key={period} value={period}>{monthLabel(period)}</option>)}
          </select>
        </label>
      </div>
      {historyLoading && <ListSkeleton count={3} />}
      {!historyLoading && history.length === 0 && (
        <p className="mt-2 text-sm text-muted">
          {historyPeriods.length === 0 ? "No loan has been given yet." : `No loan was given in ${historyPeriod ? monthLabel(historyPeriod) : historyYear}.`}
        </p>
      )}
      {!historyLoading && history.length > 0 && (
        <>
      <div className="hidden overflow-hidden rounded-[28px] border border-line bg-card lg:block">
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="p-4">Date</th><th>Member</th><th>Amount</th><th>Month</th></tr></thead>
          <tbody>
            {history.map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td className="p-4">{loanGivenOn(row.date)}</td>
                <td>{row.member}</td>
                <td><Money value={row.amount} /></td>
                <td className="text-muted">{row.opening ? `${row.month} · opening` : row.month}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 lg:hidden">
        {history.map((row) => (
          <Card key={row.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{row.member}</div>
                <div className="text-sm text-muted">{loanGivenOn(row.date)}{row.opening ? " · opening" : ""}</div>
              </div>
              <Money value={row.amount} className="text-2xl" />
            </div>
          </Card>
        ))}
      </div>
        </>
      )}
        </>
      )}
      <Sheet open={open} title="Disburse loan" onClose={() => { setOpen(false); setError(""); }}>
        <form className="grid gap-3" onSubmit={async (event) => {
          event.preventDefault();
          const message = validateDisburseLoan(form, cash);
          if (message) {
            setError(message);
            return;
          }
          setError("");
          try { await api("/api/loans", { method: "POST", body: JSON.stringify(form) }); setOpen(false); bumpBooks(); await load(); }
          catch (err) { setError(err instanceof Error ? err.message : "Could not disburse"); }
        }}>
          <label className="block text-sm text-muted">Member <span className="text-clay">*</span>
            <select className="mt-1 min-h-12 w-full rounded-2xl border border-line px-3" value={form.memberId} required onChange={(event) => { setForm({ ...form, memberId: event.target.value }); setError(""); }}>
              <option value="">Choose a member</option>
              {members.filter((row) => row.status === "ACTIVE").map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <Field label="Amount *" value={form.amount} onChange={(amount) => { setForm({ ...form, amount }); setError(""); }} />
          <p className="text-sm text-muted">Society cash in hand: {formatINR(cash)}. The loan cannot be more than this.</p>
          <Field label="Scheduled principal *" value={form.scheduledPrincipal} onChange={(scheduledPrincipal) => { setForm({ ...form, scheduledPrincipal }); setError(""); }} />
          <Field label="Date *" type="date" value={form.date} onChange={(date) => { setForm({ ...form, date }); setError(""); }} />
          <p className="text-sm text-muted">The date can be any day. The loan is booked in the open month, not by today’s calendar month.</p>
          <Field label="Purpose" value={form.purpose} onChange={(purpose) => setForm({ ...form, purpose })} />
          <Field label="Reason *" value={form.reason} onChange={(reason) => { setForm({ ...form, reason }); setError(""); }} />
          {error && <p className="text-sm text-clay">{error}</p>}
          <Button type="submit">Disburse</Button>
          <p className="text-sm text-muted">Interest and the new scheduled principal start next month. This month's Principal column stays as it is. The loan is listed under loans given.</p>
        </form>
      </Sheet>
    </Shell>
  );
}

type PayoutMethod = "CASH" | "SHARES";

type DistributionEntryRow = {
  member: string;
  nameLatin?: string;
  amount: string;
  status?: string;
  payoutMethod?: string;
};

function distributionPayoutLabel(entry: DistributionEntryRow) {
  if (entry.payoutMethod === "CASH" || entry.status === "PAID_CASH") return "Cash";
  return "Share";
}

export function AdminInterest() {
  const booksVersion = useBooksVersion();
  const bumpBooks = useBumpBooks();
  const [example, setExample] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [historyRunOpen, setHistoryRunOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [payoutMethods, setPayoutMethods] = useState<Record<string, PayoutMethod>>({});
  const [runs, setRuns] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("Equal share of interest and penalty collected and not yet distributed");
  const [ready, setReady] = useState(false);
  const [period, setPeriod] = useState("");
  const [historyYear, setHistoryYear] = useState(currentCalendarYear);
  const [historyPeriod, setHistoryPeriod] = useState("");
  const distributionPeriods = useMemo(
    () => [...new Set(runs.map((row) => row.period as string))].sort((a, b) => b.localeCompare(a)),
    [runs],
  );
  const distributionYears = useMemo(
    () => [...new Set(distributionPeriods.map((row) => row.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
    [distributionPeriods],
  );
  const historyYearOptions = useMemo(
    () => [...new Set([currentCalendarYear(), ...distributionYears])].sort((a, b) => b.localeCompare(a)),
    [distributionYears],
  );
  const historyMonthOptions = useMemo(
    () => distributionPeriods.filter((row) => row.startsWith(`${historyYear}-`)),
    [distributionPeriods, historyYear],
  );
  const filteredRuns = useMemo(() => {
    let rows = runs;
    if (historyYear) rows = rows.filter((row) => String(row.period).startsWith(`${historyYear}-`));
    if (historyPeriod) rows = rows.filter((row) => row.period === historyPeriod);
    return rows;
  }, [runs, historyYear, historyPeriod]);
  useEffect(() => {
    if (distributionYears.length === 0) return;
    if (!distributionYears.includes(historyYear)) setHistoryYear(distributionYears[0]!);
  }, [distributionYears, historyYear]);
  const loadPreview = async (p: string) => {
    setPreviewLoading(true);
    setError("");
    try {
      setPreview(await api("/api/interest/distributions/preview", { method: "POST", body: JSON.stringify({ period: p }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };
  useEffect(() => {
    Promise.all([
      api("/api/interest/example").then(setExample),
      api<any[]>("/api/interest/distributions").then(setRuns),
      fetchOpenPeriod(booksVersion).then((row) => setPeriod(row.period)),
    ]).finally(() => setReady(true));
  }, [booksVersion]);
  useEffect(() => {
    if (ready && period) void loadPreview(period);
  }, [ready, period, booksVersion]);
  const openPayoutSheet = () => {
    if (!preview?.eligibleMembers) return;
    const next: Record<string, PayoutMethod> = {};
    for (const member of preview.eligibleMembers) next[member.id] = payoutMethods[member.id] ?? "CASH";
    setPayoutMethods(next);
    setPayoutOpen(true);
  };
  const setAllPayout = (method: PayoutMethod) => {
    if (!preview?.eligibleMembers) return;
    const next: Record<string, PayoutMethod> = {};
    for (const member of preview.eligibleMembers) next[member.id] = method;
    setPayoutMethods(next);
  };
  return (
    <Shell admin>
      <h1 className="text-3xl font-semibold">Interest &amp; penalty distribution</h1>
      {!ready && <PageSkeleton cards={2} />}
      {ready && example && (
        <Card>
          <div className="text-sm text-gold">Worked example</div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat label="Interest earned" value={example.interestEarned} />
            <div><div className="text-sm text-muted">Members</div><div className="num text-2xl">{example.members}</div></div>
            <Stat label="Your interest" value={example.yourInterest} />
          </div>
          <p className="mt-3 text-sm text-muted">Ten borrowers produce different interest. Every eligible member, including the borrowers, receives the same credit from the combined pool.</p>
        </Card>
      )}
      {ready && (
        <Card>
          <div className="mb-3 text-sm text-muted">
            Interest and penalties you have collected stay in the pool until you share them. Preview uses everything not yet distributed.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={previewLoading} disabled={!period} onClick={() => void loadPreview(period)}>Refresh preview</Button>
          </div>
          {error && <p className="mt-3 text-sm text-clay">{error}</p>}
          {previewLoading && <ListSkeleton count={3} />}
          {!previewLoading && preview && !preview.collectionsComplete && (preview.unpaidMembers?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-2xl border border-clay/30 bg-clay/5 p-4 text-sm text-clay">
              <p className="font-medium">Record this month first</p>
              <p className="mt-1">
                Every active member needs a receipt for {preview.openMonth ?? "the open month"} before you distribute interest and penalty. The amount can be ₹0 if you mark them collected with no cash.
              </p>
              <ul className="mt-2 list-inside list-disc">
                {(preview.unpaidMembers as { name: string; totalDue: string }[]).map((row) => (
                  <li key={row.name}>{row.name} — no receipt yet ({formatINR(row.totalDue)} due on books)</li>
                ))}
              </ul>
              <Link to="/app/pay" className="mt-3 inline-block text-sm font-semibold text-moss">Go to collect payment →</Link>
            </div>
          )}
          {!previewLoading && preview && (
            <>
              <div className="mt-4 rounded-2xl bg-paper-deep p-4">
                <div className="text-sm text-muted">Available to distribute</div>
                <div className="num text-4xl">{formatINR(preview.poolAvailable ?? preview.interestCollected)}</div>
                <p className="mt-1 text-xs text-muted">Interest + penalty not yet shared</p>
              </div>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="mb-2 text-sm font-semibold text-ink">Interest</div>
                  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                    <div className="rounded-xl bg-paper-deep px-3 py-2">Accrued <div className="num text-lg">{formatINR(preview.interestAccrued)}</div></div>
                    <div className="rounded-xl bg-paper-deep px-3 py-2">Collected <div className="num text-lg">{formatINR(preview.interestCollected)}</div></div>
                    <div className="rounded-xl bg-paper-deep px-3 py-2">Pending collection <div className="num text-lg">{formatINR(preview.interestPending)}</div></div>
                    <div className="rounded-xl bg-paper-deep px-3 py-2">Distributed <div className="num text-lg">{formatINR(preview.interestDistributed)}</div></div>
                    <div className="rounded-xl bg-paper-deep px-3 py-2">In pool <div className="num text-lg">{formatINR(preview.interestAvailable ?? "0.00")}</div></div>
                  </div>
                  <p className="mt-2 text-xs text-muted">Accrued and pending follow loan interest on the books. Only collected interest is in the pool.</p>
                </div>
                <div>
                  <div className="mb-2 text-sm font-semibold text-ink">Penalty</div>
                  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                    <div className="rounded-xl bg-paper-deep px-3 py-2">Collected <div className="num text-lg">{formatINR(preview.penaltyCollected ?? "0.00")}</div></div>
                    <div className="rounded-xl bg-paper-deep px-3 py-2">Distributed <div className="num text-lg">{formatINR(preview.penaltyDistributed ?? "0.00")}</div></div>
                    <div className="rounded-xl bg-paper-deep px-3 py-2">In pool <div className="num text-lg">{formatINR(preview.penaltyAvailable ?? "0.00")}</div></div>
                  </div>
                  <p className="mt-2 text-xs text-muted">Collected penalties stay in the pool until you distribute them with interest.</p>
                </div>
              </div>
              <div className="mt-6 border-t border-line pt-4">
                <div className="mb-2 text-sm font-semibold text-ink">This share-out</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Per member" value={preview.perMember} />
                  <Stat label="Total" value={preview.totalDistributed} />
                  <Stat label="Rounding left over" value={preview.remaining} />
                  <div>
                    <div className="text-sm text-muted">Members sharing</div>
                    <div className="num mt-1 text-2xl">{preview.eligibleCount}</div>
                    <div className="mt-1 text-xs text-muted">Active members who get this share</div>
                  </div>
                </div>
              </div>
              <Field label="Reason" value={reason} onChange={setReason} />
              <Button full className="mt-3" disabled={!preview.canConfirm} onClick={openPayoutSheet}>Confirm distribution</Button>
            </>
          )}
        </Card>
      )}
      <Sheet open={payoutOpen} title="Distribute to members" onClose={() => setPayoutOpen(false)}>
        {preview?.eligibleMembers && (
          <>
            <p className="mb-3 text-sm text-muted">Each member receives the same amount. Choose cash or share.</p>
            <div className="mb-4 flex flex-wrap gap-2">
              <Button type="button" tone="ghost" onClick={() => setAllPayout("CASH")}>All by cash</Button>
              <Button type="button" tone="ghost" onClick={() => setAllPayout("SHARES")}>All share</Button>
            </div>
            <div className="grid max-h-[50vh] gap-2 overflow-y-auto">
              {preview.eligibleMembers.map((member: { id: string; name: string; amount: string }) => (
                <div key={member.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-paper-deep px-3 py-3">
                  <div className="min-w-0 font-medium">{member.name}</div>
                  <input
                    className="num w-28 rounded-xl border border-line bg-paper px-2 py-1 text-right text-sm opacity-80"
                    value={member.amount}
                    readOnly
                    disabled
                    aria-label={`Amount for ${member.name}`}
                  />
                  <div className="flex gap-1 text-sm">
                    <button
                      type="button"
                      className={`rounded-xl px-3 py-1 ${payoutMethods[member.id] === "CASH" ? "bg-moss text-paper" : "bg-paper text-muted"}`}
                      onClick={() => setPayoutMethods((prev) => ({ ...prev, [member.id]: "CASH" }))}
                    >
                      Cash
                    </button>
                    <button
                      type="button"
                      className={`rounded-xl px-3 py-1 ${payoutMethods[member.id] === "SHARES" ? "bg-moss text-paper" : "bg-paper text-muted"}`}
                      onClick={() => setPayoutMethods((prev) => ({ ...prev, [member.id]: "SHARES" }))}
                    >
                      Share
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="mt-3 text-sm text-clay">{error}</p>}
            <Button
              full
              className="mt-4"
              loading={confirmLoading}
              disabled={!preview.canConfirm}
              onClick={async () => {
                setConfirmLoading(true);
                setError("");
                try {
                  const payouts = preview.eligibleMembers.map((member: { id: string }) => ({
                    memberId: member.id,
                    payoutMethod: payoutMethods[member.id] ?? "CASH",
                  }));
                  await api("/api/interest/distributions/confirm", { method: "POST", body: JSON.stringify({ period, reason, payouts }) });
                  bumpBooks();
                  setRuns(await api("/api/interest/distributions"));
                  setPayoutOpen(false);
                  await loadPreview(period);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not confirm");
                } finally {
                  setConfirmLoading(false);
                }
              }}
            >
              Distribute
            </Button>
          </>
        )}
      </Sheet>
      {ready && runs.length === 0 && (
        <Empty title="No distributions yet" body="The pool stays until you share it. Refresh preview when there is collected interest or penalty to distribute." />
      )}
      {ready && runs.length > 0 && (
        <>
          <h2 className="text-xl font-semibold">Distribution history</h2>
          <p className="text-sm text-muted">Past interest and penalty share-outs by month.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Year</span>
              <select
                className="min-h-12 w-full rounded-2xl border border-line bg-white px-3"
                value={historyYear}
                onChange={(event) => {
                  setHistoryYear(event.target.value);
                  setHistoryPeriod("");
                }}
              >
                {historyYearOptions.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Month</span>
              <select
                className="min-h-12 w-full rounded-2xl border border-line bg-white px-3"
                value={historyPeriod}
                onChange={(event) => setHistoryPeriod(event.target.value)}
              >
                <option value="">All months in {historyYear}</option>
                {historyMonthOptions.map((row) => (
                  <option key={row} value={row}>{monthLabel(row)}</option>
                ))}
              </select>
            </label>
          </div>
          {filteredRuns.length === 0 && (
            <p className="mt-3 text-sm text-muted">
              No distribution in {historyPeriod ? monthLabel(historyPeriod) : historyYear}.
            </p>
          )}
          <div className="mt-3 grid gap-3">
            {filteredRuns.map((run) => {
              const interestPart = String(run.interestPortion ?? "0.00");
              const penaltyPart = String(run.penaltyPortion ?? "0.00");
              const showPoolSplit = interestPart !== "0.00" || penaltyPart !== "0.00";
              const perMember = String(run.perMemberAmount ?? "0.00");
              return (
                <button
                  key={run.id}
                  type="button"
                  className="w-full rounded-[20px] text-left transition hover:opacity-95 active:scale-[0.995]"
                  onClick={() => {
                    setSelectedRun(run);
                    setHistoryRunOpen(true);
                  }}
                >
                  <Card className="cursor-pointer">
                    <div className="flex justify-between gap-3">
                      <div>
                        <div className="font-semibold">{run.code}</div>
                        <div className="text-sm text-muted">{monthLabel(run.period)} · {run.status}</div>
                      </div>
                      <div className="text-right">
                        <Money value={run.totalDistributed} className="text-2xl" />
                        {showPoolSplit && (
                          <div className="text-xs text-muted">
                            (
                            {[interestPart !== "0.00" ? `interest ${formatINR(interestPart)}` : null, penaltyPart !== "0.00" ? `penalty ${formatINR(penaltyPart)}` : null]
                              .filter(Boolean)
                              .join(" · ")}
                            )
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 text-sm text-muted">
                      Each member got <span className="num font-medium text-ink">{formatINR(perMember)}</span>
                      {run.eligibleCount ? <> · {run.eligibleCount} members</> : null}
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      Left undistributed {formatINR(run.remaining)} · Tap for member list and cash or share
                    </div>
                  </Card>
                </button>
              );
            })}
          </div>
        </>
      )}
      <Sheet
        open={historyRunOpen}
        title={selectedRun?.code ?? "Distribution"}
        onClose={() => {
          setHistoryRunOpen(false);
          setSelectedRun(null);
        }}
      >
        {selectedRun && (
          <>
            <p className="text-sm text-muted">
              {monthLabel(selectedRun.period)} · {selectedRun.status}
            </p>
            <p className="mt-1 num text-2xl">{formatINR(selectedRun.totalDistributed)}</p>
            {(() => {
              const ip = String(selectedRun.interestPortion ?? "0.00");
              const pp = String(selectedRun.penaltyPortion ?? "0.00");
              if (ip === "0.00" && pp === "0.00") return null;
              const parts = [
                ip !== "0.00" ? `interest ${formatINR(ip)}` : null,
                pp !== "0.00" ? `penalty ${formatINR(pp)}` : null,
              ].filter(Boolean);
              return <p className="mt-1 text-xs text-muted">From pool: {parts.join(" · ")}</p>;
            })()}
            {selectedRun.reason && <p className="mt-2 text-sm text-muted">{selectedRun.reason}</p>}
            <div className="mt-4 grid max-h-[55vh] gap-2 overflow-y-auto">
              {((selectedRun.entries ?? []) as DistributionEntryRow[]).map((entry) => (
                <div
                  key={`${selectedRun.id}-${entry.member}-${entry.amount}-${entry.payoutMethod}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-paper-deep px-3 py-3"
                >
                  <div className="min-w-0 font-medium">{entry.member}</div>
                  <div className="flex items-center gap-2">
                    <span className="num text-sm">{formatINR(entry.amount)}</span>
                    <PayoutBadge mode={distributionPayoutLabel(entry)} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Sheet>
    </Shell>
  );
}

export function AdminClose() {
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [closeLoading, setCloseLoading] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("Month reviewed and reconciled");
  const collections = (preview?.collections ?? []) as { number: number; name: string; paid: string; unpaid: string }[];
  const unpaidCount = collections.filter((row) => row.unpaid !== "0.00").length;
  const paidTotal = fromPaise(collections.reduce((sum, row) => sum + paise(row.paid), 0));
  return (
    <Shell admin>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">Close month</h1>
        <Button
          loading={previewLoading}
          onClick={async () => {
            setPreviewLoading(true);
            setError("");
            try {
              setPreview(await api("/api/monthly-close/preview", { method: "POST" }));
            } catch (err) {
              setPreview(null);
              setError(err instanceof Error ? err.message : "Preview failed");
            } finally {
              setPreviewLoading(false);
            }
          }}
        >
          Review month
        </Button>
      </div>
      {error && <p className="text-sm text-clay">{error}</p>}
      {previewLoading && <ListSkeleton count={4} />}
      {!previewLoading && preview && (
        <Card>
          <h2 className="text-xl font-semibold">Collections</h2>
          <p className="mt-1 text-sm text-muted">
            {unpaidCount === 0
              ? `All ${collections.length} members are paid for ${preview.month}.`
              : `${unpaidCount} unpaid · ${collections.length - unpaidCount} paid for ${preview.month}.`}
          </p>
          <div className="mt-3 flex justify-between text-xs text-muted">
            <span>Member</span>
            <span className="flex gap-6"><span className="w-20 text-right">Paid</span><span className="w-20 text-right">Unpaid</span></span>
          </div>
          <div className="mt-2 grid gap-2">
            {collections.map((row) => (
              <div key={row.number} className="flex items-center justify-between gap-3 rounded-2xl bg-paper-deep px-3 py-3">
                <div className="min-w-0 font-medium">{row.name}</div>
                <div className="flex shrink-0 gap-6 text-right">
                  <Money value={row.paid} className={`w-20 ${row.unpaid === "0.00" ? "text-moss" : ""}`} />
                  <Money value={row.unpaid} className={`w-20 ${row.unpaid !== "0.00" ? "text-clay" : "text-muted"}`} />
                </div>
              </div>
            ))}
          </div>
          {collections.length > 0 && (
            <div className="mt-3 flex justify-between text-sm font-semibold">
              <span>Total</span>
              <span className="flex gap-6 text-right">
                <Money value={paidTotal} className="w-20" />
                <Money value={preview.stillDue} className={`w-20 ${preview.stillDue !== "0.00" ? "text-clay" : ""}`} />
              </span>
            </div>
          )}
        </Card>
      )}
      {!previewLoading && preview && (
        <Card>
          <h2 className="text-xl font-semibold">{preview.checks.ok ? "Everything reconciles" : "Financial mismatch detected"}</h2>
          <p className="mt-1 text-sm text-muted">Each line compares two figures kept in different places. They must agree before the month can close.</p>
          <div className="mt-3 grid gap-3 text-sm">
            {preview.checks.checks.map((check: any) => (
              <div key={check.name} className="flex items-start justify-between gap-3">
                <div>
                  <div>{check.name}</div>
                  <div className="text-xs text-muted">{formatINR(check.expected)} against {formatINR(check.calculated)}</div>
                </div>
                <span className={check.ok ? "text-moss" : "text-clay"}>{check.ok ? "Matches" : `Off by ${formatINR(check.difference)}`}</span>
              </div>
            ))}
          </div>
          {preview.warnings.map((warning: string) => <p key={warning} className="mt-3 text-sm text-muted">{warning}</p>)}
          <div className="mt-4"><Field label="Reason" value={reason} onChange={setReason} /></div>
          <Button
            full
            className="mt-3"
            loading={closeLoading}
            disabled={!preview.checks.ok}
            onClick={async () => {
              setCloseLoading(true);
              setError("");
              try {
                await api("/api/monthly-close/confirm", { method: "POST", body: JSON.stringify({ confirm: true, reason }) });
                location.href = "/app";
              } catch (err) {
                const details = err instanceof ApiError ? err.details : null;
                setError(err instanceof Error ? err.message : "Close failed");
                if (details) setPreview({ ...preview, checks: details });
              } finally {
                setCloseLoading(false);
              }
            }}
          >
            Close and open next month
          </Button>
        </Card>
      )}
    </Shell>
  );
}


export function AdminAudit() {
  const booksVersion = useBooksVersion();
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api<any[]>("/api/audit").then(setRows); }, [booksVersion]);
  return (
    <Shell admin>
      <h1 className="text-3xl font-semibold">Audit trail</h1>
      <p className="text-sm text-muted">Every change to the books, newest first.</p>
      {rows === null && <ListSkeleton count={5} />}
      {rows && rows.length === 0 && <Empty title="Nothing recorded yet" body="Collections, loans and edits will be listed here with who made them and why." />}
      {(rows ?? []).map((row) => (
        <Card key={row.id}>
          <div className="font-medium">{row.actorName} · {row.action}</div>
          <p className="text-sm text-muted">{row.reason}</p>
          <div className="mt-2 text-xs text-muted">{new Date(row.createdAt).toLocaleString()}</div>
        </Card>
      ))}
    </Shell>
  );
}

export function AdminImport() {
  return (
    <Shell admin>
      <h1 className="text-3xl font-semibold">Import register</h1>
      <ImportPanel />
    </Shell>
  );
}

export function AdminSettings() {
  const [settings, setSettings] = useState<any>(null);
  const { session } = useAuth();
  useEffect(() => { api("/api/settings").then(setSettings); }, []);
  const owner = session?.user.role === "OWNER";
  return (
    <Shell admin>
      <h1 className="text-3xl font-semibold">Settings</h1>
      <p className="text-sm text-muted">Everything the society can change is on this page.</p>
      {!settings && <PageSkeleton cards={3} />}
      {settings && (
        <div className="grid gap-3">
          <SocietyCard settings={settings} onSaved={(saved) => setSettings({ ...settings, ...saved })} owner={owner} />
          <InterestRateCard rate={settings.interestRate} onSaved={(interestRate) => setSettings({ ...settings, interestRate })} />
          <MonthlyShareCard share={settings.defaultMonthlyShare} owner={owner} onSaved={(defaultMonthlyShare) => setSettings({ ...settings, defaultMonthlyShare })} />
          <PasswordCard />
          <Card>
            <h2 className="font-semibold">How money is applied</h2>
            <p className="mt-1 text-sm text-muted">Each payment is applied in this order: {settings.paymentAllocationOrder.join(" → ").toLowerCase().replaceAll("_", " ")}.</p>
            <p className="mt-2 text-sm text-muted">Rounding when interest is shared: {settings.roundingPolicy.toLowerCase().replaceAll("_", " ")}.</p>
          </Card>
          <Card>
            <h2 className="font-semibold">Records</h2>
            <div className="mt-2 grid gap-2">
              <Link to="/app/audit" className="min-h-12 rounded-2xl bg-paper px-4 py-3 text-sm font-medium">Audit trail</Link>
              <Link to="/app/import" className="min-h-12 rounded-2xl bg-paper px-4 py-3 text-sm font-medium">Import register</Link>
            </div>
          </Card>
          <ReopenPreviousCard />
        </div>
      )}
    </Shell>
  );
}

function SocietyCard({ settings, owner, onSaved }: { settings: any; owner: boolean; onSaved: (saved: Record<string, string>) => void }) {
  const [form, setForm] = useState({ name: settings.name, address: settings.address, phone: settings.phone, email: settings.email });
  const [reason, setReason] = useState("Updated the society details");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  if (!owner) {
    return (
      <Card>
        <h2 className="font-semibold">Society</h2>
        <p className="mt-1 text-sm text-muted">{settings.name}</p>
        <p className="text-sm text-muted">{settings.address || "No address saved"}</p>
        <p className="mt-2 text-sm text-muted">Only the society owner can change these details.</p>
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="font-semibold">Society</h2>
      <form className="mt-3 grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        const phoneIssue = mobileError(form.phone, false, "Phone");
        if (phoneIssue) {
          setSaved("");
          setError(phoneIssue);
          return;
        }
        try {
          await api("/api/settings", { method: "PATCH", body: JSON.stringify({ ...form, phone: form.phone.trim() ? normalizeMobile(form.phone) ?? form.phone : "", reason }) });
          onSaved(form);
          setError("");
          setSaved("Society details saved.");
        } catch (err) {
          setSaved("");
          setError(err instanceof Error ? err.message : "Could not save");
        }
      }}>
        <Field label="Society name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
        <Field label="Address" value={form.address} onChange={(address) => setForm({ ...form, address })} />
        <Field label="Phone" value={form.phone} onChange={(phone) => setForm({ ...form, phone: mobileInput(phone) })} inputMode="tel" placeholder="9876543210" />
        <p className="text-sm text-muted">10-digit Indian number if you save a phone, starting with 6, 7, 8 or 9.</p>
        <Field label="Email" value={form.email} onChange={(email) => setForm({ ...form, email })} />
        <Field label="Reason for this change" value={reason} onChange={setReason} />
        <Button type="submit">Save society</Button>
      </form>
      {saved && <p className="mt-2 text-sm text-moss">{saved}</p>}
      {error && <p className="mt-2 text-sm text-clay">{error}</p>}
    </Card>
  );
}

function MonthlyShareCard({ share, owner, onSaved }: { share: string; owner: boolean; onSaved: (share: string) => void }) {
  const [value, setValue] = useState(share);
  const [reason, setReason] = useState("Changed the monthly share");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => { setValue(share); }, [share]);
  return (
    <Card>
      <h2 className="font-semibold">Monthly share</h2>
      <p className="mt-1 text-sm text-muted">Every new member pays this each month. A member can still be given their own amount.</p>
      {owner ? (
        <form className="mt-3 grid gap-3" onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api("/api/settings", { method: "PATCH", body: JSON.stringify({ defaultMonthlyShare: value, reason }) });
            onSaved(value);
            setError("");
            setSaved(`New members will pay ${formatINR(value)} each month.`);
          } catch (err) {
            setSaved("");
            setError(err instanceof Error ? err.message : "Could not save");
          }
        }}>
          <Field label="Amount" value={value} onChange={(next) => setValue(next.replace(/[^\d.]/g, ""))} inputMode="decimal" selectOnFocus />
          <Field label="Reason for this change" value={reason} onChange={setReason} />
          <Button type="submit">Save monthly share</Button>
        </form>
      ) : (
        <p className="num mt-3 text-2xl">{formatINR(share)}</p>
      )}
      {saved && <p className="mt-2 text-sm text-moss">{saved}</p>}
      {error && <p className="mt-2 text-sm text-clay">{error}</p>}
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  return (
    <Card>
      <h2 className="font-semibold">Your password</h2>
      <p className="mt-1 text-sm text-muted">Changing it signs you out of other devices.</p>
      <form className="mt-3 grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        try {
          await api("/api/auth/password", { method: "POST", body: JSON.stringify({ current, next }) });
          setCurrent("");
          setNext("");
          setError("");
          setSaved("Password changed.");
        } catch (err) {
          setSaved("");
          setError(err instanceof Error ? err.message : "Could not change the password");
        }
      }}>
        <Field label="Current password" type="password" value={current} onChange={setCurrent} />
        <Field label="New password" type="password" value={next} onChange={setNext} />
        <Button type="submit">Change password</Button>
      </form>
      {saved && <p className="mt-2 text-sm text-moss">{saved}</p>}
      {error && <p className="mt-2 text-sm text-clay">{error}</p>}
    </Card>
  );
}

function rateToPercent(rate: string) {
  const [whole, frac = ""] = String(rate || "0").split(".");
  const digits = (frac + "000000").slice(0, 6);
  const asInt = Number(whole || "0") * 1000000 + Number(digits);
  return String(asInt / 10000);
}

function InterestRateCard({ rate, onSaved }: { rate: string; onSaved: (rate: string) => void }) {
  const [percent, setPercent] = useState(rateToPercent(rate));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => { setPercent(rateToPercent(rate)); }, [rate]);
  const exampleBasis = /^\d+(\.\d{1,4})?$/.test(percent) ? Number(percent.split(".")[0] || "0") * 10000 + Number(((percent.split(".")[1] ?? "") + "0000").slice(0, 4)) : 0;
  const example = exampleBasis ? formatINR(fromPaise(exampleBasis * 10)) : "";
  return (
    <Card>
      <h2 className="text-xl font-semibold">Monthly interest rate</h2>
      <p className="mt-1 text-sm text-muted">Society admins set this. It is the percent charged each month on a member’s outstanding loan.</p>
      <form className="mt-4 grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        setSaved("");
        try {
          const updated = await api<{ interestRate: string }>("/api/settings", { method: "PATCH", body: JSON.stringify({ interestPercent: percent, reason: "Society admin set the monthly interest rate" }) });
          onSaved(updated.interestRate);
          setSaved(`Saved at ${percent}% per month.`);
          setError("");
        } catch (err) { setError(err instanceof Error ? err.message : "Could not save the interest rate"); }
      }}>
        <Field label="Percent each month" value={percent} onChange={(value) => { setPercent(value.replace(/[^\d.]/g, "")); setSaved(""); }} inputMode="decimal" placeholder="1" />
        <p className="text-sm text-muted">Type 1 for 1%. A loan of ₹1,00,000 then adds {example || "—"} interest for the month. New loans and next month’s interest use this rate.</p>
        {error && <p className="text-sm text-clay">{error}</p>}
        {saved && <p className="text-sm text-moss">{saved}</p>}
        <Button type="submit">Save interest rate</Button>
      </form>
    </Card>
  );
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function previousPeriod(period: string) {
  let year = Number(period.slice(0, 4));
  let month = Number(period.slice(5, 7));
  month -= 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function periodsThrough(start: string, end: string) {
  if (!/^\d{4}-\d{2}$/.test(start) || start > end) return [];
  const out: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const lastYear = Number(end.slice(0, 4));
  const lastMonth = Number(end.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

const IMPORT_MONTH_WINDOW = 3;

function importAllowedMonths(now: string) {
  const out: string[] = [];
  let period = now;
  for (let index = 0; index < IMPORT_MONTH_WINDOW; index += 1) {
    out.unshift(period);
    period = previousPeriod(period);
  }
  return out;
}

function importMonthChoicesLabel(months: string[]) {
  if (months.length <= 1) return monthLabel(months[0] ?? "");
  if (months.length === 2) return `${monthLabel(months[0]!)} or ${monthLabel(months[1]!)}`;
  return `${months.slice(0, -1).map(monthLabel).join(", ")}, or ${monthLabel(months.at(-1)!)}`;
}

function confirmImportUpload(period: string) {
  const label = monthLabel(period);
  return window.confirm(
    `On the paper register, is interest and penalty distribution complete through ${label}?\n\n` +
    `After you post this sheet, the app will record payments here and handle interest distribution when you close each month from ${label} onward.\n\n` +
    "Upload this file now?",
  );
}

type ImportRollbackStatus = { imported: boolean; canRollback: boolean; blockedReason: string };

function ImportPanel() {
  const { refresh } = useAuth();
  const booksVersion = useBooksVersion();
  const bumpBooks = useBumpBooks();
  const now = currentPeriod();
  const importMonths = importAllowedMonths(now);
  const defaultMonth = importMonths[0] ?? now;
  const [period, setPeriod] = useState(defaultMonth);
  const [preview, setPreview] = useState<any>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sampleDownloading, setSampleDownloading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [rollback, setRollback] = useState<ImportRollbackStatus | null>(null);
  const [interestRate, setInterestRate] = useState("");
  const catchUp = period ? periodsThrough(period, now) : [];
  const future = Boolean(period && period > now);
  const interestPercent = rateToPercent(interestRate);
  const rateExample =
    /^\d+(\.\d{1,4})?$/.test(interestPercent)
      ? formatINR(
          fromPaise(
            (Number(interestPercent.split(".")[0] || "0") * 10000 + Number(((interestPercent.split(".")[1] ?? "") + "0000").slice(0, 4))) * 10,
          ),
        )
      : "";
  useEffect(() => {
    fetchMemberCards(booksVersion).then((rows) => {
      setMemberCount(rows.length);
      if (rows.length > 0) clearImportDraft();
    }).catch(() => setMemberCount(0));
    api<{ interestRate: string }>("/api/settings").then((settings) => setInterestRate(settings.interestRate)).catch(() => undefined);
    api<ImportRollbackStatus>("/api/import/rollback").then(setRollback).catch(() => setRollback(null));
  }, [booksVersion]);
  useEffect(() => {
    if (memberCount !== 0) return;
    const draft = loadImportDraft();
    if (!draft) return;
    setPeriod(draft.period);
    setPreview(draft.preview);
    setUploadedFileName(draft.fileName);
  }, [memberCount]);
  if (memberCount === null) {
    return (
      <Card>
        <h2 className="font-semibold">Excel import</h2>
        <Bone className="mt-3 h-4 w-3/4 rounded-lg" />
        <Bone className="mt-2 h-4 w-1/2 rounded-lg" />
        <Bone className="mt-4 h-12 w-full rounded-2xl" />
      </Card>
    );
  }
  if (memberCount > 0) {
    return (
      <Card>
        <h2 className="font-semibold">Excel import</h2>
        <p className="mt-2 text-sm">Import is closed. This society already has {memberCount === 1 ? "a member" : `${memberCount} members`}.</p>
        <p className="mt-2 text-sm text-muted">A sheet can be posted only once. Collect payments for the open month and close it month by month. New members are not added by hand after an import.</p>
        {rollback?.imported && rollback.canRollback && (
          <div className="mt-4 rounded-2xl border border-clay/30 bg-clay/5 p-4">
            <p className="text-sm">Nothing has been changed since the sheet was posted. You can remove all imported register data and import again.</p>
            <Button
              tone="danger"
              full
              className="mt-3"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Remove every member and book entry from the imported sheet? Staff logins and society settings stay. You can upload a new sheet after this.")) return;
                const reason = window.prompt("Reason for removing the imported register");
                if (!reason || reason.trim().length < 3) return;
                setBusy(true);
                setError("");
                try {
                  await api("/api/import/rollback", { method: "POST", body: JSON.stringify({ confirm: true, reason: reason.trim() }) });
                  clearImportDraft();
                  clearManualMembersChoice();
                  bumpBooks();
                  setMemberCount(0);
                  setRollback({ imported: false, canRollback: false, blockedReason: "" });
                  setPreview(null);
                  setUploadedFileName("");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not remove the imported data");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete imported register data
            </Button>
          </div>
        )}
        {rollback?.imported && !rollback.canRollback && rollback.blockedReason && (
          <p className="mt-4 text-sm text-muted">{rollback.blockedReason}</p>
        )}
        {error && <p className="mt-2 text-sm text-clay">{error}</p>}
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="font-semibold">Excel import</h2>
      <p className="mt-1 text-sm text-muted">Bring the paper register in as of any of the last three months ({importMonthChoicesLabel(importMonths)}). That month opens first so you can collect its payments. After you close it, the next month opens. Skip this page if you will add members by hand — collections then start from {monthLabel(now)}. A society can import only once, and only while it has no members.</p>
      <ol className="mt-3 grid gap-1 text-sm text-muted">
        <li>1. Choose the month on the sheet — {importMonthChoicesLabel(importMonths)}.</li>
        <li>2. Download the sample if you need it, then upload your register. You must confirm that paper interest distribution is complete through the month you chose; you can remove the upload and try another file until you post.</li>
        <li>3. Total shares = shares already on the book + that month’s monthly share. Monthly share is the usual amount. Monthly share pending is cash still to collect — this month, or this month plus unpaid months. Installment = pending + previous interest + current interest + principal + penalty.</li>
        <li>4. Review the preview and post. Then collect that month, close it, and repeat.</li>
        <li>
          5. Previous interest is unpaid interest from earlier months. Current interest is this month&apos;s charge on outstanding loan at the society rate
          {interestPercent
            ? ` (${interestPercent}% per month in Settings${rateExample ? ` — e.g. ₹10,000 loan → ${rateExample} this month` : ""}).`
            : " (set in Settings)."}
          {" "}
          Penalty is a late fee, not interest — it does not use the loan rate and does not go into the interest pool.
        </li>
      </ol>
      <MonthCalendar
        label="Month on the sheet"
        value={period}
        periods={importMonths}
        onChange={(next) => { setPeriod(next); setPreview(null); setUploadedFileName(""); }}
      />
      {future && <p className="mt-2 text-sm text-clay">Choose {importMonthChoicesLabel(importMonths)}. A future month cannot be opened.</p>}
      {catchUp.length === 1 && <p className="mt-2 text-sm text-muted">{monthLabel(period)} is the current month. After posting, collect its payments here.</p>}
      {catchUp.length > 1 && (
        <p className="mt-2 text-sm text-muted">
          After posting, collect {monthLabel(catchUp[0]!)}, close it, then collect {catchUp.slice(1).map(monthLabel).join(", ")} — one month at a time.
        </p>
      )}
      <div className="mt-4">
        <Button
          tone="ghost"
          loading={sampleDownloading}
          loadingLabel="Downloading Excel…"
          disabled={sampleDownloading}
          onClick={async () => {
            setSampleDownloading(true);
            setError("");
            try {
              const response = await fetch("/api/import/sample", { credentials: "include" });
              await downloadFromResponse(response, "Society_register_sample.xlsx");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not download the sample");
            } finally {
              setSampleDownloading(false);
            }
          }}
        >
          Download sample Excel
        </Button>
      </div>
      <input className="mt-4 block w-full text-sm disabled:opacity-50" type="file" accept=".xlsx,.xls,.csv" disabled={!period || future || previewLoading} onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (!confirmImportUpload(period)) return;
        const body = new FormData();
        body.append("file", file);
        setPreviewLoading(true);
        setPreview(null);
        setUploadedFileName("");
        setError("");
        try {
          const nextPreview = await api("/api/import/preview", { method: "POST", body });
          setPreview(nextPreview);
          setUploadedFileName(file.name);
          saveImportDraft({ period, fileName: file.name, preview: nextPreview });
        } catch (err) {
          if (err instanceof ApiError && /sign in/i.test(err.message)) {
            setError("Your session was rejected by the server (often after an API restart). Sign out, sign in again, then upload once without restarting the server.");
            await refresh();
            return;
          }
          setError(err instanceof Error ? err.message : "Could not read the file");
        } finally {
          setPreviewLoading(false);
        }
      }} />
      {!period && <p className="mt-2 text-sm text-muted">Choose the month first, then the file.</p>}
      {previewLoading && <ListSkeleton count={4} />}
      {error && <p className="mt-2 text-sm text-clay">{error}</p>}
      {!previewLoading && preview && (
        <div className="mt-4 text-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-paper px-3 py-2">
            <span className="font-medium">{uploadedFileName || "Uploaded sheet"} — review before posting</span>
            <Button
              tone="ghost"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Remove this uploaded sheet? You can upload another file before posting.")) return;
                setBusy(true);
                setError("");
                try {
                  await api("/api/import/draft", { method: "DELETE" });
                  setPreview(null);
                  setUploadedFileName("");
                  clearImportDraft();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not remove the uploaded sheet");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove uploaded sheet
            </Button>
          </div>
          <div>{preview.rows.length} members · installment {formatINR(preview.totals.installment)}</div>
          <div className="text-muted">Shares {formatINR(preview.totals.shares)} · monthly share {formatINR(preview.totals.monthlyShare)} · pending {formatINR(preview.totals.sharePending)} · loans {formatINR(preview.totals.loans)}</div>
          <div className="text-muted">Opening {monthLabel(period)}</div>
          <div className="text-muted">Duplicates: {preview.duplicates.length ? preview.duplicates.join(", ") : "none"}</div>
          <div className="mt-2">{preview.validations.slice(0, 12).map((row: any) => <div key={`${row.name}${row.message}`}>{row.level}: {row.name} — {row.message}</div>)}</div>
          {!preview.canImport && (
            <p className="mt-2 text-sm text-clay">
              {preview.duplicates?.length
                ? `These names are already on file: ${preview.duplicates.join(", ")}. Import works only once — run wipe:kranti if you need a fresh start.`
                : preview.validations.some((row: { level: string }) => row.level === "error")
                  ? "Fix every error above before posting. Warnings are allowed."
                  : "Posting is blocked until the sheet is valid."}
            </p>
          )}
          <Button full className="mt-4" disabled={!preview.canImport || busy || !period || future} onClick={async () => {
            const reason = window.prompt("Reason for posting this register");
            if (!reason || reason.trim().length < 3) return;
            setBusy(true);
            try {
              await api("/api/import/confirm", { method: "POST", body: JSON.stringify({ confirm: true, reason: reason.trim(), period, rows: preview.rows }) });
              clearImportDraft();
              clearManualMembersChoice();
              window.location.assign("/app");
            } catch (err) { setError(err instanceof Error ? err.message : "Import was not posted"); }
            finally { setBusy(false); }
          }}>{preview.canImport ? `Post and open ${monthLabel(period)}` : "Posting is blocked"}</Button>
        </div>
      )}
    </Card>
  );
}

