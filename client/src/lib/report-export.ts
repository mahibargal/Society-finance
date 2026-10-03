import { apiFetch } from "./api";
import { downloadFromResponse } from "./download-blob";
import { formatINR } from "./format";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

const COLUMN_LABELS: Record<string, string> = {
  number: "No", member: "Member", shares: "Total shares", loan: "Loan", monthlyShare: "Share",
  previousInterest: "Prev. interest", currentInterest: "Interest", principal: "Principal", penalty: "Penalty",
  total: "Installment", sharePaid: "Share paid", previousInterestPaid: "Prev. int. paid",
  currentInterestPaid: "Int. paid", principalPaid: "Principal paid", penaltyPaid: "Penalty paid",
  totalReceived: "Total received", label: "Month", installment: "Installment", interestAccrued: "Interest accrued",
  interestCollected: "Interest collected", interestDistributed: "Interest distributed", principalDue: "Principal due",
  disbursed: "Loans given", principalRecovered: "Principal recovered",
};

const MONEY_KEYS = new Set([
  "shares", "loan", "monthlyShare", "previousInterest", "currentInterest", "principal", "penalty", "total",
  "sharePaid", "previousInterestPaid", "currentInterestPaid", "principalPaid", "penaltyPaid", "totalReceived",
  "installment", "interestAccrued", "interestCollected", "interestDistributed", "principalDue", "disbursed", "principalRecovered",
]);

function columnLabel(key: string) {
  return COLUMN_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function cellText(key: string, value: unknown) {
  const text = String(value ?? "");
  return MONEY_KEYS.has(key) && /^-?\d+(\.\d{1,2})?$/.test(text) ? formatINR(text) : text;
}

function tableHtml(title: string, rows: Record<string, unknown>[]) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const head = headers.map((key) => `<th class="${MONEY_KEYS.has(key) ? "right" : ""}">${escapeHtml(columnLabel(key))}</th>`).join("");
  const cells = (row: Record<string, unknown>) => headers.map((key) => `<td class="${MONEY_KEYS.has(key) ? "right" : ""}">${escapeHtml(cellText(key, row[key]))}</td>`).join("");
  const body = rows.map((row) => `<tr>${cells(row)}</tr>`).join("");
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body || "<tr><td>No rows.</td></tr>"}</tbody></table>`;
}

export function printReport(title: string, society: string, rows: Record<string, unknown>[], extra?: { title: string; rows: Record<string, unknown>[] }) {
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
    </style></head><body>
    <h1>${escapeHtml(society)}</h1><p>${escapeHtml(title)}</p>
    ${main}${more}
    </body></html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}

export async function downloadReport(report: string, format: "pdf" | "xlsx", period?: string) {
  const query = period ? `&period=${encodeURIComponent(period)}` : "";
  const response = await apiFetch(`/api/reports/${report}?format=${format}${query}`);
  await downloadFromResponse(response, `${report}.${format === "pdf" ? "pdf" : "xlsx"}`);
}
