import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { isDbConnectionError } from "./db-connection.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

const FIELD_LABELS: Record<string, string> = {
  password: "Password",
  current: "Current password",
  next: "New password",
  username: "Username",
  name: "Name",
  nameLatin: "Surname",
  societyName: "Society name",
  reason: "Reason",
  monthlyShare: "Monthly share",
  defaultMonthlyShare: "Monthly share",
  amount: "Amount",
  interestPercent: "Interest rate",
  interestRate: "Interest rate",
  joiningDate: "Joining date",
  paidOn: "Payment date",
  date: "Date",
  period: "Month",
  mobile: "Mobile",
  phone: "Phone",
  email: "Email",
  address: "Address",
  scheduledPrincipal: "Scheduled principal",
  memberId: "Member",
  penalty: "Penalty",
};

function fieldLabel(path: PropertyKey[]): string {
  const key = String(path.at(-1) ?? "");
  return FIELD_LABELS[key] ?? (key ? key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()) : "This value");
}

function friendlyIssue(issue: ZodError["issues"][number]): string {
  if (issue.code === "custom" && issue.message) return issue.message;
  const label = fieldLabel(issue.path);
  if (issue.code === "too_small" && issue.origin === "string") {
    return `${label} must be at least ${issue.minimum} characters.`;
  }
  if (issue.code === "too_big" && issue.origin === "string") {
    return `${label} must be at most ${issue.maximum} characters.`;
  }
  if (issue.code === "invalid_type") {
    return `${label} is required.`;
  }
  if (issue.code === "invalid_format") {
    if (label === "Joining date" || label === "Payment date" || label === "Date") return `${label} must look like 2026-09-05.`;
    if (label === "Month") return "Month must look like 2026-09.";
    if (label === "Interest rate") return "Interest rate must be a percent, such as 1 or 1.5.";
    if (label === "Monthly share" || label === "Amount" || label === "Scheduled principal") return `${label} must be a number, such as 500 or 500.00.`;
    return `${label} is not in the right format.`;
  }
  return `${label} is not valid.`;
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    const message = [...new Set(error.issues.map(friendlyIssue))].join(" ");
    res.status(400).json({ error: "VALIDATION", message });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: error.status === 422 ? "FINANCIAL_RECONCILIATION_ERROR" : "REQUEST_ERROR",
      message: error.message,
      details: error.details ?? null,
    });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (
    (error instanceof Error && error.name === "MoneyError")
    || message.includes("Invalid money")
    || message.includes("cannot")
    || message.includes("Invalid interest")
    || message.includes("must add up")
    || message.includes("allocation")
  ) {
    res.status(400).json({ error: "MONEY_ERROR", message });
    return;
  }
  if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "P2002") {
    res.status(409).json({ error: "REQUEST_ERROR", message: "This register was already posted for that month.", details: null });
    return;
  }
  if (isDbConnectionError(error)) {
    res.status(503).json({
      error: "DATABASE_UNAVAILABLE",
      message: "The local database connection dropped. Wait a moment and try again. Run only one API server on port 4000.",
      details: null,
    });
    return;
  }
  console.error(error);
  res.status(500).json({
    error: "SERVER_ERROR",
    message: process.env.NODE_ENV === "production" ? "Something went wrong on the server." : message,
  });
}
