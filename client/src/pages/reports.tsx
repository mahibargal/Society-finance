import { useEffect, useState } from "react";
import { MonthCalendar } from "../components/month-calendar";
import { Shell } from "../components/shell";
import { ExportDownloadButtons } from "../components/export-download-buttons";
import { Card, Empty, Money, TableSkeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBooksVersion } from "../lib/books-refresh";
import { formatINR } from "../lib/format";
import { downloadReport } from "../lib/report-export";
import { useFormatDownload } from "../lib/use-format-download";

const reports = [
  ["month-sheet", "Month sheet — to collect"],
  ["month-collected", "Month sheet — collected"],
  ["monthly", "Monthly collection"],
  ["loans", "Loans outstanding"],
  ["interest-accrued", "Interest accrued"],
  ["interest-collected", "Interest collected"],
  ["interest-distribution", "Interest distribution"],
  ["penalties", "Penalties"],
  // ["contributions", "Contributions"],
  // ["ledger", "Society ledger"],
  // ["society-balance", "Society balance"],
  // ["defaulters", "Defaulters"],
  ["monthly-closing", "Monthly closing"],
];

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function paise(value: string) {
  const [whole, frac = "00"] = (value || "0").replace(/[^\d.]/g, "").split(".");
  return Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
}

function fromPaise(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

const COLUMN_LABELS: Record<string, string> = {
  number: "No", member: "Member", shares: "Total shares", poolShareDistributed: "Distributed int+pen to shares",
  loan: "Loan", monthlyShare: "Monthly share",
  previousInterest: "Previous interest", currentInterest: "This month interest", principal: "Principal due",
  principalDeposited: "Principal paid", penalty: "Penalty", total: "Installment", received: "Received",
  stillDue: "Still due", stillToCollect: "Still to collect", sharePaid: "Share paid",
  previousInterestPaid: "Previous interest paid", currentInterestPaid: "This month interest paid",
  interestPaid: "Interest paid", principalPaid: "Principal paid", penaltyPaid: "Penalty paid",
  totalReceived: "Total received", shareBooked: "Share booked", date: "Date", amount: "Amount", period: "Month",
  status: "Status", outstanding: "Outstanding", original: "Loan given", scheduledPrincipal: "Monthly principal",
  rate: "Monthly rate", reason: "Reason", reference: "Reference", balance: "Balance", debit: "Paid out",
  credit: "Received", cash: "Cash", type: "Entry", code: "Code", assessed: "Charged", collected: "Collected",
  source: "Source", remaining: "Left over", note: "Note", label: "Month", installment: "Installment",
  disbursed: "Loans given", principalRecovered: "Principal recovered", principalDue: "Principal due",
  interestAccrued: "Interest charged", interestCollected: "Interest collected", interestDistributed: "Interest distributed",
  penaltyAssessed: "Penalty charged", penaltyCollected: "Penalty collected", penaltyDistributed: "Penalty distributed",
};

const MONEY_KEYS = new Set(["shares", "poolShareDistributed", "loan", "monthlyShare", "previousInterest", "currentInterest", "principal", "principalDeposited", "penalty", "total", "received", "stillDue", "stillToCollect", "sharePaid", "previousInterestPaid", "currentInterestPaid", "interestPaid", "principalPaid", "penaltyPaid", "totalReceived", "shareBooked", "amount", "outstanding", "original", "scheduledPrincipal", "balance", "debit", "credit", "assessed", "collected", "remaining", "installment", "disbursed", "principalRecovered", "principalDue", "interestAccrued", "interestCollected", "interestDistributed", "penaltyAssessed", "penaltyCollected", "penaltyDistributed"]);

function columnLabel(key: string) {
  return COLUMN_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function cellText(key: string, value: unknown) {
  const text = String(value ?? "");
  return MONEY_KEYS.has(key) && /^-?\d+(\.\d{1,2})?$/.test(text) ? formatINR(text) : text;
}

function totalsRow(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const summable = keys.filter((key) => MONEY_KEYS.has(key) && key !== "balance");
  if (summable.length === 0) return null;
  const row: Record<string, unknown> = {};
  let labelled = false;
  for (const key of keys) {
    if (summable.includes(key)) {
      row[key] = fromPaise(rows.reduce((sum, entry) => sum + (typeof entry[key] === "string" ? paise(entry[key] as string) : 0), 0));
    } else if (!labelled && key !== "number") {
      row[key] = "Total";
      labelled = true;
    } else {
      row[key] = "";
    }
  }
  if (!labelled) row[keys[0]] = "Total";
  return row;
}

function tableHtml(title: string, rows: Record<string, unknown>[]) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const head = headers.map((key) => `<th class="${MONEY_KEYS.has(key) ? "right" : ""}">${escapeHtml(columnLabel(key))}</th>`).join("");
  const cells = (row: Record<string, unknown>) => headers.map((key) => `<td class="${MONEY_KEYS.has(key) ? "right" : ""}">${escapeHtml(cellText(key, row[key]))}</td>`).join("");
  const body = rows.map((row) => `<tr>${cells(row)}</tr>`).join("");
  const totals = totalsRow(rows);
  const foot = totals ? `<tfoot><tr class="total">${cells(totals)}</tr></tfoot>` : "";
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body || "<tr><td>No loan was given this month.</td></tr>"}</tbody>${foot}</table>`;
}

function printReport(title: string, society: string, rows: Record<string, unknown>[], extra?: { title: string; rows: Record<string, unknown>[] }) {
  const main = tableHtml(title, rows);
  const more = extra ? tableHtml(extra.title, extra.rows) : "";
  const popup = window.open("", "_blank");
  if (!popup) {
    window.print();
    return;
  }
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>
      body { font-family: "Nirmala UI", "Outfit", sans-serif; color: #0f172a; margin: 24px; }
      h1 { font-size: 20px; margin: 0; }
      h2 { font-size: 16px; margin: 20px 0 0; }
      p { color: #475569; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
      th, td { border-bottom: 1px solid #e2e8f0; text-align: left; padding: 8px 6px; vertical-align: top; }
      th { font-size: 11px; color: #475569; }
      .right { text-align: right; }
      tfoot .total td { border-top: 1px solid #94a3b8; font-weight: 600; }
    </style></head><body>
    <h1>${escapeHtml(society)}</h1><p>${escapeHtml(title)}</p>
    ${main}${more}
    </body></html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}

type Sheet = {
  period: string;
  month: string;
  periods: string[];
  kind?: "due" | "collected";
  rows: Record<string, string>[];
  loansGiven?: { number: number; member: string; date: string; amount: string }[];
  totals: Record<string, string>;
};

const DUE_COLUMNS: [string, string][] = [
  ["shares", "Total shares"],
  ["poolShareDistributed", "Distributed int+pen to shares"],
  ["loan", "Loan"],
  ["monthlyShare", "Share"],
  ["previousInterest", "Prev. interest"],
  ["currentInterest", "Interest"],
  ["principal", "Principal"],
  ["penalty", "Penalty"],
  ["total", "Installment"],
];

const COLLECTED_COLUMNS: [string, string][] = [
  ["shares", "Total shares"],
  ["poolShareDistributed", "Distributed int+pen to shares"],
  ["loan", "Loan"],
  ["monthlyShare", "Share"],
  ["previousInterest", "Prev. interest"],
  ["currentInterest", "Interest"],
  ["principal", "Principal"],
  ["penalty", "Penalty"],
  ["sharePaid", "Share paid"],
  ["previousInterestPaid", "Prev. int. paid"],
  ["currentInterestPaid", "Int. paid"],
  ["principalPaid", "Principal paid"],
  ["penaltyPaid", "Penalty paid"],
  ["total", "Installment"],
  ["totalReceived", "Total received"],
];

function isMonthSheetReport(id: string) {
  return id === "month-sheet" || id === "month-collected";
}

/** Current snapshot — not tied to an accounting month. */
const REPORTS_WITHOUT_MONTH = new Set(["loans"]);

function reportUsesMonthFilter(id: string) {
  return !REPORTS_WITHOUT_MONTH.has(id);
}

/** Admins and members read the same society reports. Members cannot change anything, so the page is identical. */
function memberReportLabel(id: string, label: string) {
  if (id === "interest-distribution") return "Interest + penalty distribution";
  return label;
}

function ReportsPage({ admin }: { admin: boolean }) {
  const booksVersion = useBooksVersion();
  const [rows, setRows] = useState<any[]>([]);
  const [report, setReport] = useState("month-sheet");
  const [period, setPeriod] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [reportError, setReportError] = useState("");
  const [busy, setBusy] = useState(true);
  const { downloading, run: runDownload } = useFormatDownload();
  const { session } = useAuth();
  /** One loader avoids two requests racing: the due sheet must not overwrite the collected sheet after a payment. */
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const bootstrap = await api<Sheet>("/api/reports/month-sheet");
        if (cancelled) return;
        const effectivePeriod = period || bootstrap.period;
        if (!period) setPeriod(effectivePeriod);
        const periods = bootstrap.periods;

        if (isMonthSheetReport(report)) {
          const data = await api<Sheet>(
            `/api/reports/${report}?period=${encodeURIComponent(effectivePeriod)}`,
          );
          if (cancelled) return;
          setSheet({ ...data, periods });
        } else {
          const query = reportUsesMonthFilter(report)
            ? `?period=${encodeURIComponent(effectivePeriod)}`
            : "";
          const list = await api<any[]>(`/api/reports/${report}${query}`);
          if (cancelled) return;
          setRows(list);
          setSheet({ ...bootstrap, periods, period: effectivePeriod });
        }
      } catch {
        if (!cancelled) {
          setRows([]);
          setSheet(null);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [report, period, booksVersion]);
  const download = (format: "pdf" | "xlsx") => {
    const filePeriod = reportUsesMonthFilter(report) ? period || sheet?.period : undefined;
    void runDownload(format, async () => {
      setReportError("");
      await downloadReport(report, format, filePeriod);
    }).catch((err) => setReportError(err instanceof Error ? err.message : "Download failed"));
  };
  return (
    <Shell admin={admin}>
      <h1 className="text-3xl font-semibold">Reports</h1>
      {!admin && <p className="text-sm text-muted">Every report of {session?.society.name ?? "the society"}, open to read, print and download.</p>}
      <Card>
          <select className="min-h-12 w-full rounded-2xl border border-line px-3" value={report} onChange={(event) => setReport(event.target.value)}>
            {reports.map(([id, label]) => (
              <option key={id} value={id}>{admin ? label : memberReportLabel(id, label)}</option>
            ))}
          </select>
          {sheet && sheet.periods.length > 0 && reportUsesMonthFilter(report) && (
            <div>
              <MonthCalendar
                value={period || sheet.period}
                periods={sheet.periods}
                onChange={setPeriod}
              />
              {isMonthSheetReport(report) && (
                <span className="mt-1 block text-xs text-muted">Pick the month to view or download that month&apos;s member sheet.</span>
              )}
              {!isMonthSheetReport(report) && (
                <span className="mt-1 block text-xs text-muted">Pick the month to view or download that month&apos;s rows only.</span>
              )}
            </div>
          )}
          <div className="no-print mt-3 flex flex-wrap items-center gap-2">
            <ExportDownloadButtons downloading={downloading} onDownload={download} />
            <button type="button" className="min-h-11 rounded-2xl border border-line bg-white px-4 py-3 text-sm font-semibold" onClick={() => {
              if (isMonthSheetReport(report) && sheet) {
                const title = reports.find(([id]) => id === report)?.[1] ?? sheet.month;
                printReport(
                  `${title} — ${sheet.month}`,
                  session?.society.name ?? "Society Finance",
                  sheet.rows,
                  report === "month-collected" && sheet.loansGiven?.length
                    ? { title: "Loans given", rows: sheet.loansGiven }
                    : undefined,
                );
                return;
              }
              printReport(reports.find(([id]) => id === report)?.[1] ?? report, session?.society.name ?? "Society Finance", rows);
            }}>Print</button>
          </div>
          {reportError && <p className="mt-2 text-sm text-clay">{reportError}</p>}
          {busy && <TableSkeleton rows={8} />}
          {isMonthSheetReport(report) && !busy && sheet && sheet.rows.length === 0 && (
            <div className="mt-4">
              <Empty title="No members found" body="This month has no member rows yet. Add members or import a register." />
            </div>
          )}
          {isMonthSheetReport(report) && !busy && sheet && sheet.rows.length > 0 && (
            <div className="mt-4">
              <p className="mb-3 text-sm text-muted">
                {report === "month-collected"
                  ? "Amounts actually collected from each member this month, split by share, interest, principal, and penalty."
                  : "What each member should pay this month. Receipts are on the collected sheet."}
              </p>
              <div className="report-sheet -mx-5 overflow-x-auto px-5">
                <table className="w-max min-w-full text-left text-sm">
                  <thead className="text-muted">
                    <tr>
                      <th className="p-2">No</th>
                      <th className="p-2">Member</th>
                      {(report === "month-collected" ? COLLECTED_COLUMNS : DUE_COLUMNS).map(([key, label]) => (
                        <th key={key} className="whitespace-nowrap p-2 text-right">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row) => (
                      <tr key={row.number} className="border-t border-line">
                        <td className="p-2">{row.number}</td>
                        <td className="whitespace-nowrap p-2">{row.member}</td>
                        {(report === "month-collected" ? COLLECTED_COLUMNS : DUE_COLUMNS).map(([key]) => (
                          <td key={key} className="whitespace-nowrap p-2 text-right">{formatINR(row[key] ?? "0.00")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line font-semibold">
                      <td className="p-2" />
                      <td className="p-2">Total</td>
                      {(report === "month-collected" ? COLLECTED_COLUMNS : DUE_COLUMNS).map(([key]) => (
                        <td key={key} className="whitespace-nowrap p-2 text-right">{formatINR(sheet.totals[key] ?? "0.00")}</td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
              {report === "month-collected" && sheet.loansGiven && (
                <>
                  <h2 className="mt-6 text-lg font-semibold">Loans given in {sheet.month}</h2>
                  {sheet.loansGiven.length === 0 && <p className="mt-2 text-sm text-muted">No loan was given this month. A new loan appears here with the member name and amount.</p>}
                  {sheet.loansGiven.length > 0 && (
                    <div className="report-sheet -mx-5 mt-2 overflow-x-auto px-5">
                      <table className="w-max min-w-full text-left text-sm">
                        <thead className="text-muted"><tr><th className="p-2">No</th><th className="p-2">Member</th><th className="p-2">Date</th><th className="p-2 text-right">Amount</th></tr></thead>
                        <tbody>
                          {sheet.loansGiven.map((row) => (
                            <tr key={`${row.number}${row.member}`} className="border-t border-line">
                              <td className="p-2">{row.number}</td>
                              <td className="whitespace-nowrap p-2">{row.member}</td>
                              <td className="whitespace-nowrap p-2">{row.date}</td>
                              <td className="whitespace-nowrap p-2 text-right"><Money value={row.amount} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {!isMonthSheetReport(report) && !busy && rows.length === 0 && (
            <div className="mt-4">
              <Empty title="No data found" body="Nothing to show for this report yet." />
            </div>
          )}
          {!isMonthSheetReport(report) && !busy && rows.length > 0 && (
            <>
              <div className="report-cards mt-4 grid gap-3 lg:hidden">
                {rows.slice(0, 30).map((row, index) => (
                  <div key={index} className="grid gap-1 rounded-2xl bg-paper p-3 text-sm">
                    {Object.entries(row).slice(0, 5).map(([key, value]) => (
                      <div key={key} className="flex items-baseline justify-between gap-3">
                        <span className="text-muted">{columnLabel(key)}</span>
                        <span className={`min-w-0 truncate ${MONEY_KEYS.has(key) ? "num" : ""}`}>{cellText(key, value)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="report-sheet -mx-5 mt-4 hidden overflow-x-auto px-5 lg:block">
                <table className="w-max min-w-full text-left text-sm">
                  {rows[0] && (
                    <thead className="text-muted">
                      <tr>{Object.keys(rows[0]).map((key) => <th key={key} className={`whitespace-nowrap p-2 ${MONEY_KEYS.has(key) ? "text-right" : ""}`}>{columnLabel(key)}</th>)}</tr>
                    </thead>
                  )}
                  <tbody>
                    {rows.slice(0, 40).map((row, index) => (
                      <tr key={index}>
                        {Object.entries(row).map(([key, value]) => (
                          <td key={key} className={`whitespace-nowrap border-t border-line p-2 ${MONEY_KEYS.has(key) ? "text-right" : ""}`}>{cellText(key, value)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </Card>
    </Shell>
  );
}

export function AdminReports() {
  return <ReportsPage admin />;
}

export function MemberReports() {
  return <ReportsPage admin={false} />;
}
