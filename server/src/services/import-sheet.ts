import Decimal from "decimal.js";
import * as XLSX from "xlsx";
import { calculateImportedInstallment, isZero, money, sharePendingFromInstallment, sumMoney } from "../engine/finance.js";

export type MappedRow = {
  name: string;
  totalShares: string;
  loanOutstanding: string;
  monthlyShare: string;
  sharePending: string;
  previousInterest: string;
  currentInterest: string;
  principal: string;
  penalty: string;
  totalInstallment: string | null;
};

const FIELDS = [
  "name",
  "totalShares",
  "loanOutstanding",
  "monthlyShare",
  "sharePending",
  "previousInterest",
  "currentInterest",
  "principal",
  "penalty",
  "totalInstallment",
] as const;

function cell(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function asMoney(value: unknown): string {
  return asMoneyOrEmpty(value) ?? "0.00";
}

function asMoneyOrEmpty(value: unknown): string | null {
  const raw = cell(value).replace(/,/g, "").replace(/₹/g, "");
  if (!raw || raw === "-") return null;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Not a money amount: ${raw}`);
  return new Decimal(raw).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function suggestMap(headers: string[]) {
  const rules: { field: (typeof FIELDS)[number]; test: RegExp }[] = [
    { field: "name", test: /सभासद|नाव|member|name/i },
    { field: "sharePending", test: /share pending|monthly share pending|शेअर बाकी|मासिक.*बाकी|unpaid share|share due|^share$|^शेअर$/i },
    { field: "monthlyShare", test: /मासिक शेअर्स|monthly share/i },
    { field: "totalShares", test: /शेअर्स|shares/i },
    { field: "loanOutstanding", test: /शिल्लक कर्ज|कर्ज बाकी|outstanding|loan|कर्ज/i },
    { field: "previousInterest", test: /मागील|previous/i },
    { field: "currentInterest", test: /चालू|current/i },
    { field: "principal", test: /मुद्दल|principal/i },
    { field: "penalty", test: /दंड|penalty/i },
    { field: "totalInstallment", test: /हप्ता|installment|total/i },
  ];
  const map: Partial<Record<(typeof FIELDS)[number], number>> = {};
  headers.forEach((header, index) => {
    const pendingHeader = /pending|बाकी|थकबाकी|unpaid/i.test(header);
    if (pendingHeader && /मासिक|monthly|शेअर|share/i.test(header)) {
      map.sharePending = index;
      return;
    }
    if (header.includes("मासिक") && !pendingHeader) {
      map.monthlyShare = index;
      return;
    }
    for (const rule of rules) {
      if (map[rule.field] != null) continue;
      if (rule.test.test(header)) {
        map[rule.field] = index;
        break;
      }
    }
  });
  return map;
}

export function parseWorkbook(buffer: Buffer, _rate = "0.01") {
  const book = XLSX.read(buffer, { type: "buffer" });
  const sheetName = book.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(book.Sheets[sheetName], { header: 1, defval: "" });
  const headerIndex = rows.findIndex((row) => row.some((value) => /सभासद|member name|नाव/i.test(cell(value))));
  if (headerIndex < 0) throw new Error("Could not find a member-name column. Use the society register layout or English headers.");
  const headers = rows[headerIndex].map((value) => cell(value));
  const mapping = suggestMap(headers);
  if (mapping.name == null) throw new Error("The name column could not be mapped");
  const parsed: MappedRow[] = [];
  const validations: { row: number; name: string; level: "error" | "warning"; message: string }[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const name = cell(row[mapping.name]);
    if (!name || /एकूण|total/i.test(name)) continue;
    const read = (field: keyof MappedRow) => {
      const column = mapping[field];
      if (column == null) return field === "totalInstallment" ? null : "0.00";
      if (field === "name") return name;
      try {
        return asMoney(row[column]);
      } catch (error) {
        validations.push({ row: index + 1, name, level: "error", message: error instanceof Error ? error.message : "Invalid amount" });
        return "0.00";
      }
    };
    const monthlyShare = read("monthlyShare") as string;
    const previousInterest = read("previousInterest") as string;
    const currentInterest = read("currentInterest") as string;
    const principal = read("principal") as string;
    const penalty = read("penalty") as string;
    const totalInstallment = mapping.totalInstallment == null ? null : (read("totalInstallment") as string);
    let writtenPending: string | null = null;
    if (mapping.sharePending != null) {
      try {
        writtenPending = asMoneyOrEmpty(row[mapping.sharePending]);
      } catch (error) {
        validations.push({ row: index + 1, name, level: "error", message: error instanceof Error ? error.message : "Invalid amount" });
      }
    }
    let sharePending = writtenPending ?? monthlyShare;
    if (totalInstallment) {
      const implied = sharePendingFromInstallment(totalInstallment, previousInterest, currentInterest, principal, penalty);
      if (money(implied).isNegative()) {
        validations.push({
          row: index + 1,
          name,
          level: "error",
          message: `Installment ${totalInstallment} is smaller than the other dues`,
        });
      } else if (writtenPending == null || isZero(writtenPending)) {
        sharePending = implied;
      } else if (implied !== writtenPending) {
        validations.push({
          row: index + 1,
          name,
          level: "warning",
          message: `Share pending ${writtenPending} was kept. The installment leftover is ${implied}.`,
        });
      }
    }
    const item: MappedRow = {
      name,
      totalShares: read("totalShares") as string,
      loanOutstanding: read("loanOutstanding") as string,
      monthlyShare,
      sharePending,
      previousInterest,
      currentInterest,
      principal,
      penalty,
      totalInstallment,
    };
    parsed.push(item);
  }
  const names = new Set<string>();
  for (const row of parsed) {
    if (names.has(row.name)) validations.push({ row: 0, name: row.name, level: "error", message: "Duplicate member name in the file" });
    names.add(row.name);
  }
  return {
    sheetName,
    headers,
    mapping,
    rows: parsed,
    validations,
    totals: {
      shares: sumMoney(parsed.map((row) => row.totalShares)),
      loans: sumMoney(parsed.map((row) => row.loanOutstanding)),
      monthlyShare: sumMoney(parsed.map((row) => row.monthlyShare)),
      sharePending: sumMoney(parsed.map((row) => row.sharePending)),
      currentInterest: sumMoney(parsed.map((row) => row.currentInterest)),
      principal: sumMoney(parsed.map((row) => row.principal)),
      penalty: sumMoney(parsed.map((row) => row.penalty)),
      installment: sumMoney(parsed.map((row) => calculateImportedInstallment({
        sharePending: row.sharePending,
        previousInterest: row.previousInterest,
        currentInterest: row.currentInterest,
        principal: row.principal,
        penalty: row.penalty,
      }))),
    },
  };
}
