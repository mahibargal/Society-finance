const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatINR(value: string): string {
  const negative = value.startsWith("-");
  const raw = negative ? value.slice(1) : value;
  const [whole, frac = "00"] = raw.split(".");
  const paise = (frac + "00").slice(0, 2);
  let grouped = whole;
  if (whole.length > 3) {
    const tail = whole.slice(-3);
    const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${head},${tail}`;
  }
  const body = paise === "00" ? grouped : `${grouped}.${paise}`;
  return `${negative ? "-" : ""}₹${body}`;
}

export function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

export function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function nextPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** How many calendar months (including the current one) may be chosen on first import. */
export const IMPORT_MONTH_WINDOW = 3;

export function importEarliestPeriod(now = calendarPeriod()): string {
  let earliest = now;
  for (let index = 1; index < IMPORT_MONTH_WINDOW; index += 1) {
    earliest = previousPeriod(earliest);
  }
  return earliest;
}

export function importAllowedPeriods(now = calendarPeriod()): string[] {
  const out: string[] = [];
  let period = now;
  for (let index = 0; index < IMPORT_MONTH_WINDOW; index += 1) {
    out.unshift(period);
    period = previousPeriod(period);
  }
  return out;
}

export function statementDateFor(period: string): string {
  return `${period}-05`;
}

export function calendarPeriod(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
