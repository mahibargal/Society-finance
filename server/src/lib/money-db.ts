import { Prisma } from "@prisma/client";
import { moneyToString } from "../engine/finance.js";
import Decimal from "decimal.js";

export function dec(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function str(value: Prisma.Decimal | string | number | null | undefined): string {
  if (value == null) return "0.00";
  return new Decimal(value.toString()).toDecimalPlaces(2).toFixed(2);
}

export function jsonMoney(value: Prisma.Decimal | string | null | undefined): string {
  return moneyToString(new Decimal(str(value)));
}
