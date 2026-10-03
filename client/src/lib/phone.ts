export function digitsOf(value: string) {
  return value.replace(/\D/g, "");
}

export function normalizeMobile(value: string) {
  const digits = digitsOf(value);
  if (!digits) return "";
  let number = digits;
  if (number.startsWith("91") && number.length === 12) number = number.slice(2);
  if (number.startsWith("0") && number.length === 11) number = number.slice(1);
  return /^[6-9]\d{9}$/.test(number) ? number : null;
}

export function mobileError(value: string, required = false, label = "Mobile") {
  const trimmed = value.trim();
  if (!trimmed) return required ? `${label} must be a 10-digit Indian number starting with 6, 7, 8 or 9.` : "";
  if (normalizeMobile(trimmed) === null) return `${label} must be a 10-digit Indian number starting with 6, 7, 8 or 9.`;
  return "";
}

export function mobileInput(value: string) {
  return value.replace(/[^\d+\s-]/g, "").slice(0, 16);
}
