import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";

export type AuthUser = {
  userId: string;
  societyId: string;
  role: "MAIN_ADMIN" | "OWNER" | "ADMIN" | "MEMBER";
  memberId: string | null;
  name: string;
  tokenVersion: number;
};

type TokenPayload = {
  sub: string;
  societyId: string;
  role: AuthUser["role"];
  memberId: string | null;
  name: string;
  tv: number;
};

export function signToken(user: AuthUser): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return jwt.sign(
    {
      sub: user.userId,
      societyId: user.societyId,
      role: user.role,
      memberId: user.memberId,
      name: user.name,
      tv: user.tokenVersion,
    } satisfies TokenPayload,
    secret,
    { expiresIn: "12h" },
  );
}

type SelectionPayload = { kind: "society-choice"; ids: string[] };

/** A person with accounts in several societies proves the password once, then picks which society to open. */
export function signSelectionToken(userIds: string[]): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return jwt.sign({ kind: "society-choice", ids: userIds } satisfies SelectionPayload, secret, { expiresIn: "5m" });
}

export function readSelectionToken(token: string): string[] {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new HttpError(500, "Server auth is not configured");
  try {
    const payload = jwt.verify(token, secret) as SelectionPayload;
    if (payload.kind !== "society-choice" || !Array.isArray(payload.ids)) throw new Error("wrong token");
    return payload.ids;
  } catch {
    throw new HttpError(401, "The society choice expired. Please sign in again.");
  }
}

/** Returns a signed-in user when the session cookie or bearer token is valid; otherwise null. */
export async function readAuthUser(req: Request): Promise<AuthUser | null> {
  const header = req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = bearer || req.cookies?.sf_token;
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, secret) as TokenPayload;
  } catch {
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  const societyId = user?.societyId ?? "";
  if (!user || !user.isActive || user.tokenVersion !== payload.tv || societyId !== payload.societyId) return null;
  return {
    userId: user.id,
    societyId,
    role: user.role,
    memberId: user.memberId,
    name: user.name,
    tokenVersion: user.tokenVersion,
  };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = await readAuthUser(req);
    if (!auth) throw new HttpError(401, "Sign in required");
    req.auth = auth;
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, "Sign in required"));
  }
}

export function requireStaff(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth || (req.auth.role !== "OWNER" && req.auth.role !== "ADMIN")) {
    next(new HttpError(403, "This action is limited to a society admin"));
    return;
  }
  next();
}

export function requireMainAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.role !== "MAIN_ADMIN") {
    next(new HttpError(403, "Only the main admin can do this"));
    return;
  }
  next();
}

export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.role !== "OWNER") {
    next(new HttpError(403, "Only the society owner can do this"));
    return;
  }
  next();
}

export function assertOwnMember(auth: AuthUser, memberId: string) {
  if (auth.role === "MEMBER" && auth.memberId !== memberId) {
    throw new HttpError(403, "You can only open your own account");
  }
}
