import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MonthCalendar } from "../components/month-calendar";
import { Shell } from "../components/shell";
import {
  COLLECTED_COLUMNS,
  DUE_COLUMNS,
  LoansGivenTable,
  MonthSheetTable,
  MonthlyCollectionTable,
  type MonthSheet,
} from "../components/society-month-tables";
import { ExportDownloadButtons } from "../components/export-download-buttons";
import { Button, Card, TableSkeleton } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBooksVersion } from "../lib/books-refresh";
import { alertPaymentAlreadyCollected } from "../lib/collect-payment";
import { fetchReportMonthSheetBootstrap } from "../lib/staff-data";
import { downloadReport, printReport } from "../lib/report-export";
import { useFormatDownload } from "../lib/use-format-download";

type BookKind = "month-sheet" | "month-collected" | "monthly";

const META: Record<BookKind, { title: string; subtitle: string; reportId: string; printTitle: string }> = {
  "month-sheet": {
    title: "Month to collect",
    subtitle: "What each member should pay this month. Receipts are on the collected sheet.",
    reportId: "month-sheet",
    printTitle: "Month sheet — to collect",
  },
  "month-collected": {
    title: "Month collected",
    subtitle: "Amounts actually collected from each member this month, split by share, interest, principal, and penalty.",
    reportId: "month-collected",
    printTitle: "Month sheet — collected",
  },
  monthly: {
    title: "Monthly collection",
    subtitle: "Society totals for every month, oldest first — same figures as the monthly collection report.",
    reportId: "monthly",
    printTitle: "Monthly collection",
  },
};

function SocietyMonthBookView({ admin, kind }: { admin: boolean; kind: BookKind }) {
  const meta = META[kind];
  const navigate = useNavigate();
  const location = useLocation();
  const booksVersion = useBooksVersion();
  const { session } = useAuth();
  const [period, setPeriod] = useState("");
  const [sheet, setSheet] = useState<MonthSheet | null>(null);
  const [monthlyRows, setMonthlyRows] = useState<Record<string, string>[]>([]);
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const { downloading, run: runDownload } = useFormatDownload();

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const bootstrap = (await fetchReportMonthSheetBootstrap(booksVersion)) as MonthSheet;
        if (cancelled) return;
        const effectivePeriod = period || bootstrap.period;
        setOpenPeriod(bootstrap.period);

        if (kind === "monthly") {
          const series = await api<Record<string, string>[]>("/api/reports/monthly");
          if (cancelled) return;
          setMonthlyRows(series);
          setSheet({ ...bootstrap, periods: bootstrap.periods, period: effectivePeriod, rows: [], totals: {} });
        } else {
          const reuseBootstrap =
            kind === "month-sheet"
            && effectivePeriod === bootstrap.period
            && Array.isArray(bootstrap.rows)
            && bootstrap.totals;
          const data = reuseBootstrap
            ? bootstrap
            : await api<MonthSheet>(`/api/reports/${kind}?period=${encodeURIComponent(effectivePeriod)}`);
          if (cancelled) return;
          setSheet({ ...data, periods: bootstrap.periods, period: data.period ?? effectivePeriod });
          setMonthlyRows([]);
        }
        setError("");
      } catch (err) {
        if (!cancelled) {
          setSheet(null);
          setMonthlyRows([]);
          setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not load");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, period, booksVersion]);

  const societyName = session?.society.name ?? "Society Finance";
  const filePeriod = kind === "monthly" ? undefined : period || sheet?.period;
  const viewingPeriod = period || sheet?.period || openPeriod || "";

  function rowHasReceipt(row: Record<string, string>) {
    const flag = row.collectedThisOpenMonth as string | boolean | undefined;
    return flag === true || flag === "true" || flag === "1";
  }

  return (
    <Shell admin={admin}>
      <div>
        <h1 className="text-3xl font-semibold">{meta.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {meta.subtitle}
          {admin && kind === "month-sheet" && " Tap a member row to collect payment for them."}
        </p>
      </div>
      <Card className="no-print grid gap-3">
        {sheet && sheet.periods.length > 0 && kind !== "monthly" && (
          <MonthCalendar value={period || sheet.period} periods={sheet.periods} onChange={setPeriod} />
        )}
        <div className="flex flex-wrap items-center gap-2">
        <ExportDownloadButtons
          downloading={downloading}
          onDownload={(format) => {
            void runDownload(format, async () => {
              setError("");
              await downloadReport(meta.reportId, format, filePeriod);
            }).catch((err) =>
              setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Download failed"),
            );
          }}
        />
        <Button
          tone="ghost"
          onClick={() => {
            if (kind === "monthly") {
              printReport(meta.printTitle, societyName, monthlyRows as Record<string, unknown>[]);
              return;
            }
            if (!sheet) return;
            printReport(
              `${meta.printTitle} — ${sheet.month}`,
              societyName,
              sheet.rows,
              kind === "month-collected" && sheet.loansGiven?.length
                ? { title: "Loans given", rows: sheet.loansGiven }
                : undefined,
            );
          }}
        >
          Print
        </Button>
        </div>
        {error && <p className="text-sm text-clay">{error}</p>}
      </Card>
      <Card className="mt-3">
        {busy && <TableSkeleton rows={8} />}
        {!busy && kind === "monthly" && (
          <MonthlyCollectionTable rows={monthlyRows} openPeriod={openPeriod} />
        )}
        {!busy && kind !== "monthly" && !sheet && error && (
          <p className="text-sm text-muted">The sheet could not be loaded. Fix the issue above and refresh, or pick another month.</p>
        )}
        {!busy && kind !== "monthly" && sheet && (
          <>
            <MonthSheetTable
              rows={sheet.rows}
              totals={sheet.totals}
              columns={kind === "month-collected" ? COLLECTED_COLUMNS : DUE_COLUMNS}
              showCollectionStatus={admin && kind === "month-sheet" && Boolean(openPeriod && viewingPeriod === openPeriod)}
              onRowClick={
                admin && kind === "month-sheet"
                  ? (row) => {
                      if (!row.memberId) return;
                      if (openPeriod && viewingPeriod !== openPeriod) {
                        window.alert("Switch to the open month on this sheet to collect payment.");
                        return;
                      }
                      if (rowHasReceipt(row)) {
                        alertPaymentAlreadyCollected();
                        return;
                      }
                      const returnTo = location.pathname;
                      navigate(
                        `/app/pay?member=${encodeURIComponent(row.memberId)}&returnTo=${encodeURIComponent(returnTo)}`,
                        { state: { returnTo } },
                      );
                    }
                  : undefined
              }
            />
            {kind === "month-collected" && <LoansGivenTable month={sheet.month} rows={sheet.loansGiven} />}
          </>
        )}
      </Card>
    </Shell>
  );
}

export function AdminMonthToCollect() {
  return <SocietyMonthBookView admin kind="month-sheet" />;
}

export function AdminMonthCollected() {
  return <SocietyMonthBookView admin kind="month-collected" />;
}

export function AdminMonthlyCollection() {
  return <SocietyMonthBookView admin kind="monthly" />;
}

export function MemberMonthToCollect() {
  return <SocietyMonthBookView admin={false} kind="month-sheet" />;
}

export function MemberMonthCollected() {
  return <SocietyMonthBookView admin={false} kind="month-collected" />;
}

export function MemberMonthlyCollection() {
  return <SocietyMonthBookView admin={false} kind="monthly" />;
}
