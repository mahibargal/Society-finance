import { formatINR } from "../lib/format";
import { Empty } from "./ui";

type HistoryRow = {
  period: string;
  label: string;
  shares: string;
  poolShareDistributed?: string;
  loan: string;
  previousDue: string;
  monthlyShare: string;
  previousInterest: string;
  interest: string;
  principal: string;
  penalty: string;
  arrears: string;
  total: string;
  received: string;
  stillDue: string;
};

type HistoryTotals = {
  shares: string;
  poolShareDistributed?: string;
  loan: string;
  previousDue: string;
  monthlyShare: string;
  previousInterest: string;
  interest: string;
  principal: string;
  penalty: string;
  total: string;
  received: string;
  stillDue: string;
};

const COLUMNS: { key: keyof HistoryTotals; label: string }[] = [
  { key: "shares", label: "Shares" },
  { key: "poolShareDistributed", label: "Distributed int+pen to shares" },
  { key: "loan", label: "Loan" },
  { key: "previousDue", label: "Prev month due" },
  { key: "monthlyShare", label: "Share" },
  { key: "previousInterest", label: "Prev. interest" },
  { key: "interest", label: "Interest" },
  { key: "principal", label: "Principal" },
  { key: "penalty", label: "Penalty" },
  { key: "total", label: "Installment" },
  { key: "received", label: "Received" },
  { key: "stillDue", label: "Still due" },
];

function emptyTotals(): HistoryTotals {
  return {
    shares: "0.00",
    poolShareDistributed: "0.00",
    loan: "0.00",
    previousDue: "0.00",
    monthlyShare: "0.00",
    previousInterest: "0.00",
    interest: "0.00",
    principal: "0.00",
    penalty: "0.00",
    total: "0.00",
    received: "0.00",
    stillDue: "0.00",
  };
}

const INACTIVE_HISTORY_MESSAGE =
  "Month-wise history is not available while this member is inactive. Activate the member to start a fresh month report from the open month.";

export function MemberHistoryTable({
  rows,
  totals,
  openPeriod,
  memberInactive,
}: {
  rows: HistoryRow[];
  totals?: HistoryTotals | null;
  openPeriod?: string | null;
  memberInactive?: boolean;
}) {
  if (memberInactive) {
    return <Empty title="Not available" body={INACTIVE_HISTORY_MESSAGE} />;
  }
  if (rows.length === 0) {
    return <Empty title="No months yet" body="When the society opens a month, that month will appear here as a row." />;
  }
  const footer = totals ?? emptyTotals();
  return (
    <div className="report-sheet -mx-5 overflow-x-auto px-5">
      <table className="w-max min-w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="p-2">Month</th>
            {COLUMNS.map((column) => (
              <th key={column.key} className="whitespace-nowrap p-2 text-right">{column.label}</th>
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
              {COLUMNS.map((column) => (
                <td key={column.key} className="whitespace-nowrap p-2 text-right num">{formatINR(row[column.key] ?? "0.00")}</td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line font-semibold">
            <td className="p-2">Total</td>
            {COLUMNS.map((column) => (
              <td key={column.key} className="whitespace-nowrap p-2 text-right num">{formatINR(footer[column.key] ?? "0.00")}</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
