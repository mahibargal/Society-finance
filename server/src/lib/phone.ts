import { z } from "zod";

const MOBILE_MESSAGE = "Mobile must be a 10-digit Indian number starting with 6, 7, 8 or 9.";
const PHONE_MESSAGE = "Phone must be a 10-digit Indian number starting with 6, 7, 8 or 9.";

export function digitsOf(value: string) {
  return value.replace(/\D/g, "");
}

/** Empty string if blank. Ten digits if valid. Null if invalid. */
export function normalizeMobile(value: string) {
  const digits = digitsOf(value);
  if (!digits) return "";
  let number = digits;
  if (number.startsWith("91") && number.length === 12) number = number.slice(2);
  if (number.startsWith("0") && number.length === 11) number = number.slice(1);
  return /^[6-9]\d{9}$/.test(number) ? number : null;
}

export function indianMobileSchema(required: boolean, label: "Mobile" | "Phone" = "Mobile") {
  const message = label === "Phone" ? PHONE_MESSAGE : required ? MOBILE_MESSAGE : MOBILE_MESSAGE;
  return z
    .string()
    .trim()
    .max(16)
    .refine((value) => {
      if (!value) return !required;
      return normalizeMobile(value) !== null;
    }, { message: required && label === "Mobile" ? MOBILE_MESSAGE : message })
    .transform((value) => (value ? normalizeMobile(value) ?? "" : ""));
}
