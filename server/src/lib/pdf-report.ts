import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { Response } from "express";
import { sumMoney } from "../engine/finance.js";
import { formatINR } from "./format.js";

const bundledFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/NotoSansDevanagari-Regular.ttf");

const FONT_CANDIDATES = [
  bundledFont,
  "C:\\Windows\\Fonts\\Nirmala.ttf",
  "C:\\Windows\\Fonts\\mangal.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
];

const COLUMN_LABELS: Record<string, string> = {
  number: "No",
  member: "Member",
  shares: "Total shares",
  poolShareDistributed: "Distributed int+pen to shares",
  loan: "Loan",
  monthlyShare: "Monthly share",
  previousInterest: "Previous interest",
  currentInterest: "This month interest",
  principal: "Principal due",
  principalDeposited: "Principal paid",
  penalty: "Penalty",
  total: "Installment",
  received: "Received",
  stillDue: "Still due",
  stillToCollect: "Still to collect",
  sharePaid: "Share paid",
  previousInterestPaid: "Previous interest paid",
  currentInterestPaid: "This month interest paid",
  interestPaid: "Interest paid",
  principalPaid: "Principal paid",
  penaltyPaid: "Penalty paid",
  totalReceived: "Total received",
  shareBooked: "Share booked",
  date: "Date",
  amount: "Amount",
  period: "Month",
  status: "Status",
  outstanding: "Outstanding",
  original: "Loan given",
  scheduledPrincipal: "Monthly principal",
  rate: "Monthly rate",
  reason: "Reason",
  reference: "Reference",
  balance: "Balance",
  debit: "Paid out",
  credit: "Received",
  cash: "Cash",
  type: "Entry",
  code: "Code",
  assessed: "Charged",
  collected: "Collected",
  source: "Source",
  remaining: "Left over",
  note: "Note",
  label: "Month",
  previousDue: "Prev month due",
  interest: "Interest",
  installment: "Installment",
  disbursed: "Loans given",
  principalRecovered: "Principal recovered",
  principalDue: "Principal due",
  interestAccrued: "Interest charged",
  interestCollected: "Interest collected",
  interestDistributed: "Interest distributed",
  penaltyAssessed: "Penalty charged",
  penaltyCollected: "Penalty collected",
  penaltyDistributed: "Penalty distributed",
};

const MONEY_KEYS = new Set([
  "shares", "poolShareDistributed", "loan", "monthlyShare", "previousDue", "previousInterest", "interest", "currentInterest", "principal", "principalDeposited",
  "penalty", "total", "received", "stillDue", "stillToCollect", "sharePaid", "previousInterestPaid",
  "currentInterestPaid", "interestPaid", "principalPaid", "penaltyPaid", "totalReceived", "shareBooked", "amount", "outstanding", "original",
  "scheduledPrincipal", "balance", "debit", "credit", "assessed", "collected", "remaining", "installment",
  "disbursed", "principalRecovered", "principalDue", "interestAccrued", "interestCollected", "interestDistributed",
  "penaltyAssessed", "penaltyCollected", "penaltyDistributed",
]);

/** A running balance is already a total, so adding the column would be meaningless. */
const NOT_SUMMABLE = new Set(["balance"]);

function fontPath() {
  return FONT_CANDIDATES.find((file) => fs.existsSync(file)) ?? null;
}

export function totalsRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const summable = keys.filter((key) => MONEY_KEYS.has(key) && !NOT_SUMMABLE.has(key));
  if (summable.length === 0) return null;
  const row: Record<string, unknown> = {};
  let labelled = false;
  for (const key of keys) {
    if (summable.includes(key)) {
      row[key] = sumMoney(rows.map((entry) => (typeof entry[key] === "string" && /^-?\d+(\.\d{1,2})?$/.test(entry[key] as string) ? (entry[key] as string) : "0.00")));
      continue;
    }
    if (!labelled && key !== "number") {
      row[key] = "Total";
      labelled = true;
      continue;
    }
    row[key] = "";
  }
  if (!labelled) row[keys[0]] = "Total";
  return row;
}

export function columnLabel(key: string) {
  return COLUMN_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

/** UI / API-only keys on month-to-collect rows — not for printed or spreadsheet exports. */
const MONTH_SHEET_INTERNAL_ROW_KEYS = new Set([
  "memberId",
  "collectedThisOpenMonth",
  "collectionStatus",
  "collectionStatusLabel",
]);

export function monthSheetRowsForExport(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !MONTH_SHEET_INTERNAL_ROW_KEYS.has(key))),
  );
}

function plain(value: unknown, unicode: boolean) {
  const text = value == null ? "" : String(value);
  if (unicode) return text;
  return text.replace(/[^\t\n\r\x20-\x7E]/g, "");
}

function cellText(key: string, value: unknown, unicode: boolean) {
  if (MONEY_KEYS.has(key) && typeof value === "string" && /^-?\d+(\.\d{1,2})?$/.test(value)) {
    return plain(formatINR(value), unicode);
  }
  return plain(value, unicode);
}

/** Names need room; money columns do not. Weights keep long Marathi names on one line. */
function columnWeight(key: string) {
  if (key === "number") return 0.4;
  if (key === "member" || key === "reason" || key === "note") return 2.2;
  if (key === "date" || key === "period" || key === "label") return 1;
  return 1.1;
}

function drawTable(doc: InstanceType<typeof PDFDocument>, unicode: boolean, rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    doc.fontSize(11).text("No rows.", doc.page.margins.left, doc.y);
    return;
  }
  const keys = Object.keys(rows[0]);
  const weights = keys.map(columnWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = weights.map((weight) => (pageWidth * weight) / totalWeight);
  const offsets = widths.map((_, index) => doc.page.margins.left + widths.slice(0, index).reduce((sum, width) => sum + width, 0));
  const align = (key: string) => (MONEY_KEYS.has(key) ? "right" : "left") as "right" | "left";

  const header = () => {
    doc.fontSize(8).fillColor("#475569");
    const y = doc.y;
    const labels = keys.map((key) => plain(columnLabel(key), unicode));
    const height = Math.max(12, ...labels.map((label, index) => doc.heightOfString(label, { width: widths[index] - 8 })));
    labels.forEach((label, index) => {
      doc.text(label, offsets[index], y, { width: widths[index] - 8, align: align(keys[index]) });
    });
    doc.y = y + height + 4;
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#cbd5e1").stroke();
    doc.y += 6;
    doc.fillColor("#0f172a");
  };

  header();
  for (const row of rows) {
    doc.fontSize(8);
    const values = keys.map((key) => cellText(key, row[key], unicode));
    const height = Math.max(12, ...values.map((value, index) => doc.heightOfString(value || " ", { width: widths[index] - 8 })));
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    values.forEach((value, index) => {
      doc.text(value || " ", offsets[index], y, { width: widths[index] - 8, align: align(keys[index]) });
    });
    doc.y = y + height + 6;
  }
  const totals = rows.at(-1)?.label === "Total" ? null : totalsRow(rows);
  if (totals) {
    doc.fontSize(8);
    const values = keys.map((key) => cellText(key, totals[key], unicode));
    const height = Math.max(12, ...values.map((value, index) => doc.heightOfString(value || " ", { width: widths[index] - 8 })));
    if (doc.y + height + 8 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      header();
    }
    doc.moveTo(doc.page.margins.left, doc.y - 2).lineTo(doc.page.width - doc.page.margins.right, doc.y - 2).strokeColor("#94a3b8").stroke();
    doc.y += 4;
    const y = doc.y;
    values.forEach((value, index) => {
      doc.text(value || " ", offsets[index], y, { width: widths[index] - 8, align: align(keys[index]) });
    });
    doc.y = y + height + 6;
  }
  doc.x = doc.page.margins.left;
}

export function sendReportPdf(
  res: Response,
  title: string,
  rows: Record<string, unknown>[],
  extra?: { heading?: string; rows?: Record<string, unknown>[]; fileName?: string; societyName?: string },
) {
  const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
  const unicode = Boolean(fontPath());
  const fileName = (extra?.fileName ?? title).replace(/[^\w. -]/g, " ").replace(/\s+/g, " ").trim();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}.pdf"`);
  doc.pipe(res);
  if (unicode) doc.font(fontPath()!);
  doc.fillColor("#0f172a").fontSize(16).text(plain(extra?.societyName || "Society Finance", unicode), doc.page.margins.left, doc.y);
  doc.moveDown(0.2).fontSize(12).fillColor("#475569").text(plain(title, unicode), doc.page.margins.left, doc.y);
  doc.fillColor("#0f172a");
  doc.moveDown(0.8);
  if (rows.length === 0) doc.fontSize(11).text("This report has no rows.", doc.page.margins.left, doc.y);
  else drawTable(doc, unicode, rows);
  if (extra?.heading && extra.rows !== undefined) {
    doc.moveDown(1.2).fontSize(12).text(plain(extra.heading, unicode), doc.page.margins.left, doc.y, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
    doc.moveDown(0.5);
    if (extra.rows.length === 0) doc.fontSize(11).text("No loan was given this month.", doc.page.margins.left, doc.y);
    else drawTable(doc, unicode, extra.rows);
  }
  doc.end();
}
