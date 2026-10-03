import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { Response } from "express";
import { formatINR, monthLabel } from "./format.js";

/** Matches client `styles.css` theme tokens. */
const MOSS = "#0f766e";
const MOSS_DEEP = "#0d9488";
const INK = "#0f172a";
const MUTED = "#475569";
const LINE = "#e2e8f0";
const PAPER = "#f8fafc";
const CARD = "#ffffff";

const bundledFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/NotoSansDevanagari-Regular.ttf");

const FONT_CANDIDATES = [
  bundledFont,
  "C:\\Windows\\Fonts\\Nirmala.ttf",
  "C:\\Windows\\Fonts\\mangal.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
];

const ALLOCATION_LABELS: Record<string, string> = {
  SHARE: "Monthly share",
  PREVIOUS_INTEREST: "Pending interest (prior month)",
  CURRENT_INTEREST: "Interest on outstanding loan",
  PRINCIPAL: "Principal repayment",
  PENALTY: "Penalty",
};

function fontPath() {
  return FONT_CANDIDATES.find((file) => fs.existsSync(file)) ?? null;
}

function useDocumentFont(doc: Doc, unicode: boolean) {
  const file = fontPath();
  if (unicode && file) doc.font(file);
  else doc.font("Helvetica");
}

function plain(value: unknown, unicode: boolean) {
  const text = value == null ? "" : String(value);
  if (unicode) return text;
  return text.replace(/[^\t\n\r\x20-\x7E]/g, "");
}

function resolveLogoFile(logoUrl: string | null | undefined) {
  if (!logoUrl) return null;
  const name = logoUrl.replace(/^\/uploads\//, "").replace(/^uploads\//, "");
  if (!name || name.includes("..")) return null;
  const file = path.resolve("uploads", name);
  return fs.existsSync(file) ? file : null;
}

function displayDate(isoDate: string) {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1] ?? m} ${y}`;
}

function displayGeneratedAt(date: Date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, ${date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
}

type Doc = InstanceType<typeof PDFDocument>;

function contentWidth(doc: Doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function textBlock(doc: Doc, x: number, y: number, label: string, value: string, width: number, unicode: boolean) {
  doc.fontSize(8).fillColor(MUTED).text(plain(label, unicode), x, y, { width, lineBreak: false });
  doc.fontSize(11).fillColor(INK).text(plain(value, unicode), x, y + 11, { width, lineBreak: false });
}

function drawBrandHeader(
  doc: Doc,
  unicode: boolean,
  input: {
    societyName: string;
    societyAddress: string;
    societyPhone: string;
    societyEmail: string;
    logoUrl?: string | null;
  },
) {
  const pageW = doc.page.width;
  const headerH = 96;
  const left = doc.page.margins.left;

  doc.save();
  doc.rect(0, 0, pageW, headerH).fill(MOSS);
  doc.rect(0, headerH - 3, pageW, 3).fill(MOSS_DEEP);
  doc.restore();

  const logoFile = resolveLogoFile(input.logoUrl);
  let nameX = left;
  const nameY = 22;
  if (logoFile) {
    try {
      doc.save();
      doc.roundedRect(left, 18, 56, 56, 12).fill("#ffffff");
      doc.image(logoFile, left + 4, 22, { fit: [48, 48] });
      doc.restore();
      nameX = left + 68;
    } catch {
      /* skip broken image */
    }
  }

  const nameW = pageW - nameX - doc.page.margins.right;
  doc.fillColor("#ffffff").fontSize(9).opacity(0.85).text("SOCIETY FINANCE", nameX, 24, { width: nameW, characterSpacing: 0.6 });
  doc.opacity(1).fontSize(17).text(plain(input.societyName, unicode), nameX, 38, { width: nameW, lineGap: 1 });

  const contact: string[] = [];
  if (input.societyAddress.trim()) contact.push(input.societyAddress.trim());
  if (input.societyPhone.trim()) contact.push(input.societyPhone.trim());
  if (input.societyEmail.trim()) contact.push(input.societyEmail.trim());
  if (contact.length > 0) {
    doc.fontSize(8).opacity(0.9).text(plain(contact.join("  ·  "), unicode), nameX, doc.y + 2, { width: nameW, lineGap: 1 });
    doc.opacity(1);
  }

  doc.y = headerH + 22;
  doc.x = left;
}

function drawReceiptTitleAndMeta(
  doc: Doc,
  unicode: boolean,
  input: { receiptNo: string; paidOn: string; period: string; memberName: string; memberNumber?: number },
) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const y0 = doc.y;

  doc.fillColor(MOSS).fontSize(22).text("Receipt", left, y0, { width: width * 0.45, lineBreak: false });
  doc.fontSize(10).fillColor(MUTED).text("Official payment record", left, y0 + 28, { width: width * 0.45, lineBreak: false });

  const badgeW = 118;
  const badgeX = left + width - badgeW;
  doc.roundedRect(badgeX, y0, badgeW, 26, 13).fill(MOSS);
  doc.fillColor("#ffffff").fontSize(10).text("Paid in full", badgeX, y0 + 8, { width: badgeW, align: "center", lineBreak: false });

  doc.y = y0 + 52;

  const rowY = doc.y;
  const colW = width / 3;
  textBlock(doc, left, rowY, "Receipt no.", input.receiptNo, colW - 8, unicode);
  textBlock(doc, left + colW, rowY, "Payment date", displayDate(input.paidOn), colW - 8, unicode);
  textBlock(doc, left + colW * 2, rowY, "Books month", monthLabel(input.period), colW - 8, unicode);

  doc.y = rowY + 38;
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.y += 14;

  const memberLine = input.memberNumber != null ? `${input.memberName}  ·  Member no. ${input.memberNumber}` : input.memberName;
  doc.fontSize(8).fillColor(MUTED).text("Received from", left, doc.y);
  doc.fontSize(13).fillColor(INK).text(plain(memberLine, unicode), left, doc.y + 12, { width });
  doc.y += 36;
  doc.x = left;
}

function drawLineItemsTable(doc: Doc, unicode: boolean, rows: { label: string; amount: string }[], total: string) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const descW = width * 0.7;
  const amtW = width * 0.3;
  const amtX = left + descW;

  const headerY = doc.y;
  doc.rect(left, headerY, width, 24).fill(MOSS);
  doc.fillColor("#ffffff").fontSize(9);
  doc.text("Description", left + 12, headerY + 7, { width: descW - 16, lineBreak: false });
  doc.text("Amount", amtX, headerY + 7, { width: amtW - 12, align: "right", lineBreak: false });
  doc.y = headerY + 24;

  const bodyRows =
    rows.length === 0
      ? [{ label: "No installment line was applied (zero-amount receipt).", amount: formatINR("0.00") }]
      : rows.map((row) => ({ label: row.label, amount: formatINR(row.amount) }));

  for (let index = 0; index < bodyRows.length; index += 1) {
    const row = bodyRows[index];
    const rowY = doc.y;
    const rowH = 28;
    if (index % 2 === 1) doc.rect(left, rowY, width, rowH).fill(PAPER);
    doc.moveTo(left, rowY + rowH).lineTo(left + width, rowY + rowH).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.fillColor(INK).fontSize(10);
    doc.text(plain(row.label, unicode), left + 12, rowY + 8, { width: descW - 16, lineBreak: false });
    doc.text(plain(row.amount, unicode), amtX, rowY + 8, { width: amtW - 12, align: "right", lineBreak: false });
    doc.y = rowY + rowH;
  }

  const totalY = doc.y;
  doc.rect(left, totalY, width, 34).fill(MOSS);
  doc.fillColor("#ffffff").fontSize(10).text("Total received", left + 12, totalY + 10, { width: descW - 16, lineBreak: false });
  doc.fontSize(14).text(plain(formatINR(total), unicode), amtX, totalY + 9, { width: amtW - 12, align: "right", lineBreak: false });
  doc.y = totalY + 34;
  doc.rect(left, headerY, width, doc.y - headerY).lineWidth(1).strokeColor(LINE).stroke();
  doc.fillColor(INK);
  doc.y += 20;
  doc.x = left;
}

function noteLineText(line: string, unicode: boolean) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (unicode) return trimmed;
  return plain(trimmed, false);
}

function drawNotes(doc: Doc, unicode: boolean, lines: string[]) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const parts = lines.map((line) => noteLineText(line, unicode)).filter(Boolean);
  if (parts.length === 0) return;

  useDocumentFont(doc, unicode);
  doc.fontSize(8).fillColor(MUTED).text("Notes", left, doc.y, { lineBreak: false });
  const innerW = width - 24;
  const lineGap = 4;
  doc.fontSize(9).fillColor(INK);
  const lineHeights = parts.map((line) => doc.heightOfString(line, { width: innerW, lineGap }));
  const textH = lineHeights.reduce((sum, height) => sum + height + lineGap, 0) - lineGap;
  const boxY = doc.y + 8;
  const boxH = textH + 16;
  doc.roundedRect(left, boxY, width, boxH, 8).fillAndStroke(CARD, LINE);

  let textY = boxY + 8;
  useDocumentFont(doc, unicode);
  doc.fillColor(INK).fontSize(9);
  for (const line of parts) {
    doc.text(line, left + 12, textY, { width: innerW, lineGap, lineBreak: true });
    textY += doc.heightOfString(line, { width: innerW, lineGap }) + lineGap;
  }
  doc.y = boxY + boxH + 16;
  doc.x = left;
}

function drawFooter(doc: Doc, unicode: boolean, generatedAt: Date) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const footerY = Math.max(doc.y + 24, doc.page.height - doc.page.margins.bottom - 56);

  doc.moveTo(left, footerY).lineTo(left + width, footerY).strokeColor(LINE).lineWidth(1).stroke();
  doc.fillColor(MUTED).fontSize(8);
  doc.text(
    plain("Thank you for your payment. Computer-generated receipt from Society Finance.", unicode),
    left,
    footerY + 10,
    { width, align: "center", lineGap: 1 },
  );
  doc.text(`Generated ${displayGeneratedAt(generatedAt)}`, left, footerY + 26, { width, align: "center", lineBreak: false });
}

export type PaymentReceiptPdfInput = {
  societyName: string;
  societyAddress?: string;
  societyPhone?: string;
  societyEmail?: string;
  logoUrl?: string | null;
  receiptNo: string;
  memberName: string;
  memberNumber?: number;
  period: string;
  paidOn: string;
  amount: string;
  reason: string;
  note?: string;
  noteLines?: string[];
  allocations: { component: string; amount: string }[];
};

export function sendPaymentReceiptPdf(res: Response, input: PaymentReceiptPdfInput) {
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  const unicode = Boolean(fontPath());
  const safeName = input.receiptNo.replace(/[^\w.-]/g, "_");
  const generatedAt = new Date();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
  doc.pipe(res);
  useDocumentFont(doc, unicode);

  drawBrandHeader(doc, unicode, {
    societyName: input.societyName,
    societyAddress: input.societyAddress ?? "",
    societyPhone: input.societyPhone ?? "",
    societyEmail: input.societyEmail ?? "",
    logoUrl: input.logoUrl,
  });

  drawReceiptTitleAndMeta(doc, unicode, {
    receiptNo: input.receiptNo,
    paidOn: input.paidOn,
    period: input.period,
    memberName: input.memberName,
    memberNumber: input.memberNumber,
  });

  const lineRows = input.allocations
    .filter((row) => row.amount !== "0.00")
    .map((row) => ({
      label: ALLOCATION_LABELS[row.component] ?? row.component.replaceAll("_", " "),
      amount: row.amount,
    }));

  drawLineItemsTable(doc, unicode, lineRows, input.amount);
  const noteLines =
    input.noteLines ??
    [input.reason, input.note ?? ""].map((line) => line.trim()).filter(Boolean);
  drawNotes(doc, unicode, noteLines);
  drawFooter(doc, unicode, generatedAt);

  doc.end();
}
