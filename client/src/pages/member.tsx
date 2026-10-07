import { useEffect, useState } from "react";
import { ClipboardList, FileText, Landmark, Receipt, Table2, Wallet } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { FeatureLink, SectionTitle } from "../components/home-links";
import { Shell } from "../components/shell";
import { MemberHistoryTable } from "../components/member-history";
import { ExportDownloadButtons } from "../components/export-download-buttons";
import { Bone, Button, Card, Empty, ListSkeleton, Money, PageSkeleton, PayoutBadge, Sheet, Stat } from "../components/ui";
import { api } from "../lib/api";
import { useBooksVersion } from "../lib/books-refresh";
import { fetchMemberProfile } from "../lib/staff-data";
import { downloadFromResponse } from "../lib/download-blob";
import { useFormatDownload } from "../lib/use-format-download";
import { downloadPaymentReceipt } from "../lib/payment-receipt";
import { formatINR, monthLabel } from "../lib/format";

export function MemberHome() {
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetchMemberProfile(booksVersion).then(setData); }, [booksVersion]);
  if (!data) return <Shell><PageSkeleton cards={2} /></Shell>;
  const latest = data.timeline.at(-1);
  return (
    <Shell>
      <div className="rounded-[24px] bg-gradient-to-br from-moss to-[#0d9488] p-5 text-white shadow-[0_14px_40px_rgba(15,118,110,0.35)]">
        <div className="text-sm text-white/80">Hello,</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{data.member.name}</h1>
        {data.due && (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-white/70">This month due</div>
            <Money value={data.due.totalDue} className="text-3xl text-white" />
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          [Receipt, "Payments", "/me/payments"],
          [Landmark, "Loan", "/me/loan"],
          [Wallet, "Int. + penalty", "/me/interest"],
        ].map(([icon, label, to]) => {
          const Icon = icon as typeof Receipt;
          return (
          <Link
            key={String(to)}
            to={String(to)}
            className="flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-[20px] border border-line bg-card text-sm font-semibold text-moss shadow-[0_6px_18px_rgba(15,23,42,0.04)] transition active:scale-[0.98]"
          >
            <Icon size={22} strokeWidth={2} />
            {label}
          </Link>
          );
        })}
      </div>
      <div className="grid gap-2">
        <SectionTitle>Books</SectionTitle>
        <FeatureLink to="/me/my-report" title="My month report" hint="Your row for every month" icon={FileText} primary />
        <FeatureLink to="/me/month-sheet" title="Month to collect" hint="Society dues for all members" icon={ClipboardList} />
        <FeatureLink to="/me/month-collected" title="Month collected" hint="What the society received" icon={Table2} />
      </div>
      <Card className="bg-pine text-white">
        <div className="text-sm text-white/70">Total shares</div>
        <Money value={data.member.shareBalance} className="text-5xl" />
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <Link to="/me/interest" className="block rounded-[20px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-moss">
          <Card className="h-full transition hover:bg-paper-deep">
            <Stat label="Interest + penalty earned" value={data.member.interestEarned} />
            <p className="mt-2 text-xs text-muted">Tap for pool history</p>
          </Card>
        </Link>
        <Card><Stat label="Outstanding loan" value={data.member.loanOutstanding} /></Card>
        <Card><Stat label="Current interest" value={latest?.interest ?? "0.00"} /></Card>
      </div>
      {data.due && (
        <Card>
          <div className="text-sm font-medium text-muted">Due breakdown</div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-muted">
            {Object.entries(data.due.dues as Record<string, string>).map(([key, value]) => <span key={key}>{key.replaceAll("_", " ").toLowerCase()} {formatINR(value)}</span>)}
          </div>
        </Card>
      )}
    </Shell>
  );
}

async function downloadMyReport(format: "pdf" | "xlsx") {
  const response = await fetch(`/api/me?format=${format}`, { credentials: "include" });
  await downloadFromResponse(response, `My_month_report.${format === "pdf" ? "pdf" : "xlsx"}`);
}

export function MemberMonthReport() {
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  const [reportError, setReportError] = useState("");
  const { downloading, run: runDownload } = useFormatDownload();
  useEffect(() => { fetchMemberProfile(booksVersion).then(setData); }, [booksVersion]);
  if (!data) return <Shell><PageSkeleton cards={1} /></Shell>;
  return (
    <Shell>
      <div>
        <h1 className="text-3xl font-semibold">My month report</h1>
        <p className="mt-1 text-sm text-muted">{data.member.name} · {data.society.name} · every month, oldest first</p>
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">
        <ExportDownloadButtons
          downloading={downloading}
          onDownload={(format) => {
            void runDownload(format, async () => {
              setReportError("");
              await downloadMyReport(format);
            }).catch((err) => setReportError(err instanceof Error ? err.message : "Download failed"));
          }}
        />
        <Button tone="ghost" onClick={() => window.print()}>Print</Button>
      </div>
      {reportError && <p className="no-print text-sm text-clay">{reportError}</p>}
      <Card>
        <MemberHistoryTable
          rows={data.timeline}
          totals={data.timelineTotals}
          openPeriod={data.openPeriod}
          memberInactive={data.member.status === "INACTIVE"}
        />
      </Card>
    </Shell>
  );
}

export function MemberPayments() {
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  const [downloading, setDownloading] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { fetchMemberProfile(booksVersion).then(setData); }, [booksVersion]);
  const rows: any[] = data?.payments ?? [];
  const months = [...new Set(rows.map((row) => row.period as string))].sort((a, b) => b.localeCompare(a));
  return (
    <Shell>
      <h1 className="text-3xl font-semibold">Payments</h1>
      {error && <p className="text-sm text-clay">{error}</p>}
      {!data && <ListSkeleton count={3} />}
      {data && rows.length === 0 && <Empty title="No receipts yet" body="When the office records your payment, the receipt will show the split between share, interest, principal and penalty." />}
      {months.map((period) => {
        const receipts = rows.filter((row) => row.period === period);
        return (
          <section key={period} className="grid gap-2">
            <h2 className="px-1 text-lg font-semibold">{monthLabel(period)}</h2>
            {receipts.map((row: any) => (
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
                <div className="flex justify-between">
                  <div>
                    <div className="font-semibold">{row.receiptNo}</div>
                    <div className="text-sm text-muted">{new Date(row.paidOn).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</div>
                    <div className="mt-1 text-xs text-moss">{downloading === row.id ? "Preparing PDF…" : "Tap to download receipt"}</div>
                  </div>
                  <Money value={row.amount} className="text-2xl" />
                </div>
                <div className="mt-3 grid gap-1 text-sm">{row.allocations.map((item: any) => <div key={item.component} className="flex justify-between"><span>{item.component.replaceAll("_", " ").toLowerCase()}</span><span>{formatINR(item.amount)}</span></div>)}</div>
              </Card>
            ))}
          </section>
        );
      })}
    </Shell>
  );
}

export function MemberLoan() {
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetchMemberProfile(booksVersion).then(setData); }, [booksVersion]);
  const loan = data?.loans?.[0];
  return (
    <Shell>
      <h1 className="text-3xl font-semibold">Loan</h1>
      {!data && <PageSkeleton cards={2} />}
      {data && !loan && <Empty title="No outstanding loan" body="Your share account is separate. A loan appears here only when the society disburses one to you." />}
      {loan && (
        <>
          <Card>
            <Stat label="Outstanding" value={loan.outstandingPrincipal} />
            <div className="mt-2 text-sm text-muted">
              {loan.status.replaceAll("_", " ")}
              {data.due ? ` · this month principal ${formatINR(data.due.dues.PRINCIPAL)}` : ""}
              {data.due && data.due.dues.PRINCIPAL !== loan.scheduledPrincipal
                ? ` · new schedule ${formatINR(loan.scheduledPrincipal)} starts next month`
                : ` · monthly principal ${formatINR(loan.scheduledPrincipal)}`}
            </div>
          </Card>
          {loan.transactions.map((row: any) => (
            <Card key={row.id}><div className="text-sm text-muted">{row.type.replaceAll("_", " ")}</div><Money value={row.amount} className="text-2xl" /><p className="mt-2 text-sm text-muted">{row.reason}</p></Card>
          ))}
        </>
      )}
    </Shell>
  );
}

type InterestHistoryRow = {
  period: string;
  label: string;
  amount: string;
  payoutLabel: string;
  mode: string;
  code: string;
};

export function MemberInterest() {
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { fetchMemberProfile(booksVersion).then(setData); }, [booksVersion]);
  const rows = (data?.interestHistory ?? []) as InterestHistoryRow[];
  const summary = data?.interestSummary;
  const earned = summary?.earned ?? data?.member.interestEarned ?? "0.00";
  const withdrawn = summary?.withdrawn ?? data?.member.interestWithdrawn ?? "0.00";
  const addedToShares = summary?.addedToShares ?? "0.00";
  return (
    <Shell>
      <h1 className="text-3xl font-semibold">Interest + penalty</h1>
      {!data && <PageSkeleton cards={2} />}
      {data && (
        <button type="button" className="w-full text-left" onClick={() => rows.length > 0 && setHistoryOpen(true)}>
          <Card className={rows.length > 0 ? "cursor-pointer transition hover:bg-paper-deep" : ""}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-sm text-muted">Total interest + penalty earned</div>
                <div className="num mt-1 text-3xl">{formatINR(earned)}</div>
              </div>
              <div>
                <div className="text-sm text-muted">Withdrawn</div>
                <div className="num mt-1 text-3xl">{formatINR(withdrawn)}</div>
              </div>
              <div>
                <div className="text-sm text-muted">Added to shares</div>
                <div className="num mt-1 text-3xl">{formatINR(addedToShares)}</div>
              </div>
            </div>
            {rows.length > 0 && <p className="mt-3 text-xs text-muted">Tap to see month-wise history (cash or share)</p>}
          </Card>
        </button>
      )}
      {data && rows.length === 0 && <Empty title="No pool share yet" body="You receive a share after the society distributes the interest and penalty pool." />}
      {rows.map((row) => (
        <Card key={row.code + row.period}>
          <div className="flex justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold">{row.label}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>Interest + penalty pool</span>
                <PayoutBadge mode={row.payoutLabel} />
              </div>
            </div>
            <Money value={row.amount} className="shrink-0 text-2xl" />
          </div>
        </Card>
      ))}
      <Sheet open={historyOpen} title="Interest + penalty history" onClose={() => setHistoryOpen(false)}>
        <p className="mb-3 text-sm text-muted">Each row is a pool distribution for that month (cash or added to shares).</p>
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto">
          {rows.map((row) => (
            <div key={row.code + row.period} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-paper-deep px-3 py-3">
              <div>
                <div className="font-medium">{row.label}</div>
                <div className="text-xs text-muted">{row.code}</div>
              </div>
              <div className="flex items-center gap-2">
                <Money value={row.amount} className="text-lg" />
                <PayoutBadge mode={row.payoutLabel} />
              </div>
            </div>
          ))}
        </div>
      </Sheet>
    </Shell>
  );
}

export function MemberMore() {
  const navigate = useNavigate();
  const booksVersion = useBooksVersion();
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState("");
  useEffect(() => { fetchMemberProfile(booksVersion).then(setData); }, [booksVersion]);
  return (
    <Shell>
      <h1 className="text-3xl font-semibold">More</h1>
      <Card>
        {!data && (
          <>
            <Bone className="h-6 w-40 rounded-lg" />
            <Bone className="mt-2 h-4 w-56 rounded-lg" />
          </>
        )}
        <h2 className="font-semibold">{data?.member.name}</h2>
        <p className="text-sm text-muted">{data?.society.name}</p>
        <div className="mt-4 grid gap-2">
          <Link to="/me/my-report"><Button tone="ghost" full>My month report</Button></Link>
          <Button tone="ghost" onClick={() => window.print()}>Print statement</Button>
          <Button tone="ghost" onClick={async () => {
            if (!data) return;
            const draft = await api<{ text: string }>(`/api/members/${data.member.id}/whatsapp?kind=statement`);
            setText(draft.text);
          }}>Prepare WhatsApp statement</Button>
          <Button tone="danger" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); navigate("/"); }}>Sign out</Button>
        </div>
        {text && <div className="mt-4"><p className="whitespace-pre-wrap text-sm">{text}</p><Button full className="mt-3" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank")}>Open WhatsApp</Button></div>}
      </Card>
      {data && (
        <Card className="print:block">
          <div className="text-xs tracking-[0.16em] text-gold">SOCIETY FINANCE</div>
          <h2 className="mt-2 text-2xl">{data.society.name}</h2>
          <p className="mt-4">Member: {data.member.name}</p>
          <p>Shares: {formatINR(data.member.shareBalance)}</p>
          <p>Loan: {formatINR(data.member.loanOutstanding)}</p>
          <p>Interest + penalty earned: {formatINR(data.member.interestEarned)}</p>
          {data.interestSummary && (
            <>
              <p>Withdrawn: {formatINR(data.interestSummary.withdrawn)}</p>
              <p>Added to shares: {formatINR(data.interestSummary.addedToShares)}</p>
            </>
          )}
          {data.due && <p>This month due: {formatINR(data.due.totalDue)}</p>}
        </Card>
      )}
    </Shell>
  );
}
