import { api } from "./api";

export type MemberCard = {
  id: string;
  name: string;
  memberNumber: number;
  status: string;
  username?: string;
  totalDue: string;
  shareBalance: string;
  loanOutstanding: string;
  currentInterest: string;
  principalDue: string;
  interestBalance?: string;
  collectedThisOpenMonth?: boolean;
};

export type RegisterPolicy = { canAddMembers: boolean; importedRegister?: boolean };

const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** One in-flight request per booksVersion — Shell and Collect both use this. */
export function fetchMemberCards(booksVersion: number) {
  return dedupe(`members:v${booksVersion}`, () => api<MemberCard[]>("/api/members"));
}

export function fetchRegisterPolicy(booksVersion: number) {
  return dedupe(`register-policy:v${booksVersion}`, () => api<RegisterPolicy>("/api/members/register-policy"));
}

export function fetchOpenPeriod(booksVersion: number) {
  return dedupe(`open-period:v${booksVersion}`, () => api<{ period: string }>("/api/open-period"));
}

export function fetchNotifications(booksVersion: number) {
  return dedupe(`notifications:v${booksVersion}`, () => api<{ readAt: string | null }[]>("/api/notifications"));
}
