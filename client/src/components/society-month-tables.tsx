import { formatINR } from "../lib/format";
import { Empty, Money } from "./ui";

export type MonthSheet = {
  period: string;
  month: string;
  periods: string[];
  rows: Record<string, string>[];
  loansGiven?: { number: number; member: string; date: string; amount: string }[];
  totals: Record<string, string>;
};

export const DUE_COLUMNS: [string, string][] = [
  ["shares", "Total shares"],
  ["loan", "Loan"],
  ["monthlyShare", "Share"],
  ["previousInterest", "Prev. interest"],
  ["currentInterest", "Interest"],
  ["principal", "Principal"],
  ["penalty", "Penalty"],
  ["total", "Installment"],
];

export const COLLECTED_COLUMNS: [string, string][] = [
  ["shares", "Total shares"],
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

export const MONTHLY_COLLECTION_COLUMNS: [string, string][] = [
  ["monthlyShare", "Share"],
  ["installment", "Installment"],
  ["interestAccrued", "Interest accrued"],
  ["interestCollected", "Interest collected"],
  ["interestDistributed", "Interest distributed"],
  ["principalDue", "Principal due"],
  ["disbursed", "Loans given"],
  ["principalRecovered", "Principal recovered"],
];

function CollectionStatusBadge({ status }: { status: string }) {
  if (status === "collected") {
    return <span className="ml-2 rounded-full bg-moss/15 px-2 py-0.5 text-xs font-medium text-moss">Collected</span>;
  }
  if (status === "partial") {
    return <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Partially collected</span>;
  }
  return null;
}

export function MonthSheetTable({
  rows,
  totals,
  columns,
  onRowClick,
  showCollectionStatus = false,
}: {
  rows: Record<string, string>[];
  totals: Record<string, string>;
  columns: [string, string][];
  /** When set, rows with memberId open collect (admin month to collect). */
  onRowClick?: (row: Record<string, string>) => void;
  /** Show Collected / Partially collected for the open month (month to collect). */
  showCollectionStatus?: boolean;
}) {
  if (rows.length === 0) {
    return <Empty title="No members found" body="This month has no member rows yet. Add members or import a register." />;
  }
  return (
    <div className="report-sheet -mx-5 overflow-x-auto px-5">
      <table className="w-max min-w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="p-2">No</th>
            <th className="p-2">Member</th>
            {columns.map(([key, label]) => (
              <th key={key} className="whitespace-nowrap p-2 text-right">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const collectionStatus = row.collectionStatus ?? "";
            const clickable = Boolean(onRowClick && row.memberId);
            const showCollectLink = clickable && collectionStatus !== "collected" && collectionStatus !== "partial";
            return (
              <tr
                key={row.memberId ?? row.number}
                className={`border-t border-line ${clickable ? "cursor-pointer transition hover:bg-paper-deep active:bg-paper" : ""}`}
                onClick={clickable ? () => onRowClick!(row) : undefined}
                onKeyDown={clickable ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onRowClick!(row);
                  }
                } : undefined}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
              >
                <td className="p-2">{row.number}</td>
                <td className="whitespace-nowrap p-2">
                  {row.member}
                  {showCollectionStatus && collectionStatus && (
                    <CollectionStatusBadge status={collectionStatus} />
                  )}
                  {showCollectLink && <span className="ml-2 text-xs font-medium text-moss">Collect →</span>}
                </td>
                {columns.map(([key]) => (
                  <td key={key} className="whitespace-nowrap p-2 text-right">{formatINR(row[key] ?? "0.00")}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line font-semibold">
            <td className="p-2" />
            <td className="p-2">Total</td>
            {columns.map(([key]) => (
              <td key={key} className="whitespace-nowrap p-2 text-right">{formatINR(totals[key] ?? "0.00")}</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function LoansGivenTable({ month, rows }: { month: string; rows: MonthSheet["loansGiven"] }) {
  if (!rows) return null;
  return (
    <>
      <h2 className="mt-6 text-lg font-semibold">Loans given in {month}</h2>
      {rows.length === 0 && <p className="mt-2 text-sm text-muted">No loan was given this month.</p>}
      {rows.length > 0 && (
        <div className="report-sheet -mx-5 mt-2 overflow-x-auto px-5">
          <table className="w-max min-w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="p-2">No</th><th className="p-2">Member</th><th className="p-2">Date</th><th className="p-2 text-right">Amount</th></tr></thead>
            <tbody>
              {rows.map((row) => (
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
  );
}

export function MonthlyCollectionTable({
  rows,
  openPeriod,
}: {
  rows: Record<string, string>[];
  openPeriod?: string | null;
}) {
  if (rows.length === 0) {
    return <Empty title="No months yet" body="When a month is opened, it will appear here as a row." />;
  }
  return (
    <div className="report-sheet -mx-5 overflow-x-auto px-5">
      <table className="w-max min-w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="p-2">Month</th>
            {MONTHLY_COLLECTION_COLUMNS.map(([key, label]) => (
              <th key={key} className="whitespace-nowrap p-2 text-right">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.period} className={`border-t border-line ${openPeriod === row.period ? "bg-moss/5" : ""}`}>
              <td className="whitespace-nowrap p-2 font-medium">
                {row.label}
                {openPeriod === row.period && <span className="ml-2 text-xs font-semibold text-moss">Open</span>}
              </td>
              {MONTHLY_COLLECTION_COLUMNS.map(([key]) => (
                <td key={key} className="whitespace-nowrap p-2 text-right">{formatINR(row[key] ?? "0.00")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
