export function formatINR(value: string | number | null | undefined): string {
  const rawValue = value == null || value === "" ? "0.00" : String(value);
  const negative = rawValue.startsWith("-");
  const raw = negative ? rawValue.slice(1) : rawValue;
  const [whole, frac = "00"] = raw.split(".");
  const paise = (frac + "00").slice(0, 2);
  let grouped = whole || "0";
  if (grouped.length > 3) {
    const tail = grouped.slice(-3);
    const head = grouped.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${head},${tail}`;
  }
  const body = paise === "00" ? grouped : `${grouped}.${paise}`;
  return `${negative ? "-" : ""}₹${body}`;
}

export function monthLabel(period: string): string {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month] = period.split("-");
  return `${names[Number(month) - 1] ?? period} ${year ?? ""}`.trim();
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function wordsUnder100(value: number): string {
  if (value < 20) return SMALL[value] ?? "";
  const ten = Math.floor(value / 10);
  const one = value % 10;
  return one ? `${TENS[ten]}-${SMALL[one]}` : TENS[ten] ?? "";
}

function wordsUnder1000(value: number): string {
  if (value < 100) return wordsUnder100(value);
  const hundred = Math.floor(value / 100);
  const rest = value % 100;
  return rest ? `${SMALL[hundred]} hundred ${wordsUnder100(rest)}` : `${SMALL[hundred]} hundred`;
}

export function rupeesInWords(value: string | number | null | undefined): string {
  const rawValue = value == null || value === "" ? "0.00" : String(value);
  const negative = rawValue.startsWith("-");
  const raw = negative ? rawValue.slice(1) : rawValue;
  const [whole, frac = "00"] = raw.split(".");
  const rupees = Number(whole || "0");
  const paise = Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(paise)) return "";
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  const parts = [
    crore ? `${wordsUnder1000(crore)} crore` : "",
    lakh ? `${wordsUnder100(lakh)} lakh` : "",
    thousand ? `${wordsUnder1000(thousand)} thousand` : "",
    rest ? wordsUnder1000(rest) : "",
  ].filter(Boolean);
  const rupeeText = rupees === 0 ? "zero rupees" : `${parts.join(" ")} ${rupees === 1 ? "rupee" : "rupees"}`;
  const paiseText = paise ? ` and ${wordsUnder100(paise)} paise` : "";
  const sentence = `${negative ? "minus " : ""}${rupeeText}${paiseText}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
