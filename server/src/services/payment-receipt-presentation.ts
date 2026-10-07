import type { Prisma } from "@prisma/client";
import {
  isZero,
  money,
  shareDueOnBooks,
  shareOnSheet,
  subtractMoney,
  sumMoney,
} from "../engine/finance.js";
import { str } from "../lib/money-db.js";

export const RECEIPT_META_PREFIX = "\u001eRCPT:";

export type ReceiptCollectedLine = { label: string; amount: string };

export type ReceiptPending = {
  installment: string;
  principal: string;
  nextMonthPenalty: string;
};

export type StoredReceiptMeta = {
  v: 1;
  lines: ReceiptCollectedLine[];
  pending: ReceiptPending;
};

type StatementRow = {
  shareCashPending: Prisma.Decimal;
  arrearsCash: Prisma.Decimal;
  monthlyShare: Prisma.Decimal;
  previousInterest: Prisma.Decimal;
  currentInterest: Prisma.Decimal;
  principalDue: Prisma.Decimal;
  penalty: Prisma.Decimal;
};

function sheetParts(statement: StatementRow) {
  const shareDue = shareDueOnBooks(str(statement.shareCashPending), str(statement.arrearsCash));
  const share = shareOnSheet(str(statement.monthlyShare), shareDue);
  return {
    share,
    previousInterest: str(statement.previousInterest),
    currentInterest: str(statement.currentInterest),
    principal: str(statement.principalDue),
    penalty: str(statement.penalty),
  };
}

function amountByComponent(
  allocations: { component: string; amount: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of allocations) {
    out[row.component] = sumMoney([out[row.component] ?? "0.00", row.amount]);
  }
  return out;
}

function splitShareCollected(
  shareAmount: string,
  shareSplit?: { monthly: string; arrear: string },
): { monthly: string; arrear: string } {
  if (shareSplit && !isZero(shareAmount)) {
    return { monthly: shareSplit.monthly, arrear: shareSplit.arrear };
  }
  if (isZero(shareAmount)) return { monthly: "0.00", arrear: "0.00" };
  return { monthly: shareAmount, arrear: "0.00" };
}

export function buildCollectedLines(
  allocations: { component: string; amount: string }[],
  shareSplit?: { monthly: string; arrear: string },
): ReceiptCollectedLine[] {
  const by = amountByComponent(allocations);
  const shareParts = splitShareCollected(by.SHARE ?? "0.00", shareSplit);
  const rows: ReceiptCollectedLine[] = [
    { label: "Monthly share", amount: shareParts.monthly },
    { label: "Interest on the loan", amount: by.CURRENT_INTEREST ?? "0.00" },
    { label: "Pending share from last month", amount: shareParts.arrear },
    { label: "Penalty due", amount: by.PENALTY ?? "0.00" },
    { label: "Pending interest from last month", amount: by.PREVIOUS_INTEREST ?? "0.00" },
    { label: "Principal repaid", amount: by.PRINCIPAL ?? "0.00" },
  ];
  return rows.filter((row) => !isZero(row.amount));
}

function maxZero(value: string) {
  return money(value).isNegative() ? "0.00" : value;
}

export function buildReceiptStorageNote(input: {
  statement: StatementRow;
  paidBefore: Record<string, string>;
  allocations: { component: string; amount: string }[];
  shareSplit?: { monthly: string; arrear: string };
  nextMonthPenalty?: string;
}): string {
  const parts = sheetParts(input.statement);
  const installmentDue = sumMoney([parts.share, parts.previousInterest, parts.currentInterest, parts.penalty]);
  const by = amountByComponent(input.allocations);
  const paidInstBefore = sumMoney([
    input.paidBefore.SHARE ?? "0.00",
    input.paidBefore.PREVIOUS_INTEREST ?? "0.00",
    input.paidBefore.CURRENT_INTEREST ?? "0.00",
    input.paidBefore.PENALTY ?? "0.00",
  ]);
  const paidInstThis = sumMoney([
    by.SHARE ?? "0.00",
    by.PREVIOUS_INTEREST ?? "0.00",
    by.CURRENT_INTEREST ?? "0.00",
    by.PENALTY ?? "0.00",
  ]);
  const pendingInstallment = maxZero(subtractMoney(installmentDue, sumMoney([paidInstBefore, paidInstThis])));
  const pendingPrincipal = maxZero(
    subtractMoney(parts.principal, sumMoney([input.paidBefore.PRINCIPAL ?? "0.00", by.PRINCIPAL ?? "0.00"])),
  );
  const meta: StoredReceiptMeta = {
    v: 1,
    lines: buildCollectedLines(input.allocations, input.shareSplit),
    pending: {
      installment: pendingInstallment,
      principal: pendingPrincipal,
      nextMonthPenalty: input.nextMonthPenalty ?? "0.00",
    },
  };
  return RECEIPT_META_PREFIX + JSON.stringify(meta);
}

export function parseReceiptMeta(note: string): { meta: StoredReceiptMeta | null; userNote: string } {
  const trimmed = note.trim();
  if (!trimmed.startsWith(RECEIPT_META_PREFIX)) {
    return { meta: null, userNote: trimmed };
  }
  const rest = trimmed.slice(RECEIPT_META_PREFIX.length);
  const newline = rest.indexOf("\n");
  const jsonPart = newline === -1 ? rest : rest.slice(0, newline);
  const userNote = newline === -1 ? "" : rest.slice(newline + 1).trim();
  try {
    const parsed = JSON.parse(jsonPart) as StoredReceiptMeta;
    if (parsed?.v !== 1 || !Array.isArray(parsed.lines) || !parsed.pending) {
      return { meta: null, userNote: trimmed };
    }
    return { meta: parsed, userNote };
  } catch {
    return { meta: null, userNote: trimmed };
  }
}

export function receiptPaidInFull(pending: ReceiptPending) {
  return isZero(pending.installment) && isZero(pending.principal) && isZero(pending.nextMonthPenalty);
}

const ALLOCATION_FALLBACK_LABELS: Record<string, string> = {
  SHARE: "Share (monthly + pending share)",
  PREVIOUS_INTEREST: "Pending interest from last month",
  CURRENT_INTEREST: "Interest on the loan",
  PRINCIPAL: "Principal repaid",
  PENALTY: "Penalty due",
};

export function collectedLinesFromPayment(
  note: string,
  allocations: { component: string; amount: string }[],
): ReceiptCollectedLine[] {
  const { meta } = parseReceiptMeta(note);
  if (meta?.lines?.length) return meta.lines;
  return allocations
    .filter((row) => !isZero(row.amount))
    .map((row) => ({
      label: ALLOCATION_FALLBACK_LABELS[row.component] ?? row.component.replaceAll("_", " "),
      amount: row.amount,
    }));
}

export function pendingFromMeta(note: string): ReceiptPending | null {
  const { meta } = parseReceiptMeta(note);
  return meta?.pending ?? null;
}
