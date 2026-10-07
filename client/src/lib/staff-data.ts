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
  shareDue?: string;
  interestDue?: string;
  previousSharePending?: string;
  previousInterestPending?: string;
  previousPending?: string;
  penaltyDue?: string;
  /** Installment column on Month to collect (excludes penalty). */
  installmentDue?: string;
  installmentBreakdown?: {
    share: string;
    previousInterest: string;
    currentInterest: string;
    principal: string;
    penalty?: string;
    total: string;
  };
  monthlyShare?: string;
  principalDue?: string;
  scheduledPrincipal?: string;
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

/** In-memory cache per booksVersion — survives Shell remounts on route change. */
function fetchCached<T>(
  store: Map<number, T>,
  booksVersion: number,
  dedupeKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const cached = store.get(booksVersion);
  if (cached !== undefined) return Promise.resolve(cached);
  return dedupe(dedupeKey, run).then((value) => {
    store.set(booksVersion, value);
    return value;
  });
}

const membersByVersion = new Map<number, MemberCard[]>();
const registerPolicyByVersion = new Map<number, RegisterPolicy>();
const openPeriodByVersion = new Map<number, { period: string }>();
const notificationsByVersion = new Map<number, NotificationRow[]>();
const dashboardByVersion = new Map<number, StaffDashboard>();
const memberProfileByVersion = new Map<number, MemberProfile>();
const monthSheetBootstrapByVersion = new Map<number, ReportMonthSheetBootstrap>();

/** Drop cached staff reads so the next fetch hits the API (after bumpBooks). */
export function invalidateStaffDataCaches() {
  membersByVersion.clear();
  registerPolicyByVersion.clear();
  openPeriodByVersion.clear();
  notificationsByVersion.clear();
  dashboardByVersion.clear();
  memberProfileByVersion.clear();
  monthSheetBootstrapByVersion.clear();
  inflight.clear();
}

type NotificationRow = { id: string; readAt: string | null };

export type StaffDashboard = {
  society: { name: string };
  period: string;
  month: string;
  members: { total: number; active: number };
  canAddMembers?: boolean;
  importedRegister?: boolean;
  shares: string;
  loansOutstanding: string;
  societyCash: string;
  societyCashLedger?: string;
  societyCashBreakdown?: {
    total: string;
    adds: { name: string; amount: string }[];
    less: { name: string; amount: string }[];
    also?: { name: string; amount: string }[];
  };
  monthCollected?: { total: string; share: string; interest: string; principal: string; penalty: string };
  interest: {
    accrued: string;
    collected: string;
    pending: string;
    distributed: string;
    available: string;
    combinedAvailable?: string;
    penaltyCollected?: string;
    penaltyAvailable?: string;
  };
  installment: {
    monthlyShare: string;
    previousInterest: string;
    currentInterest: string;
    principal: string;
    penalty: string;
    total: string;
    stillDue: string;
  };
  series: {
    period: string;
    label: string;
    interestAccrued: string;
    interestCollected: string;
    interestDistributed: string;
    disbursed: string;
    principalRecovered: string;
  }[];
};

export type MemberProfile = Record<string, unknown>;

/** Default period + month list for month-sheet / reports (not period-specific rows). */
export type ReportMonthSheetBootstrap = {
  period: string;
  periods: string[];
  rows?: unknown[];
  totals?: Record<string, string>;
};

export function replaceRegisterPolicyCache(booksVersion: number, policy: RegisterPolicy) {
  registerPolicyByVersion.set(booksVersion, policy);
}

export function replaceNotificationsCache(booksVersion: number, rows: NotificationRow[]) {
  notificationsByVersion.set(booksVersion, rows);
}

export function fetchMemberCards(booksVersion: number) {
  return fetchCached(membersByVersion, booksVersion, `members:v${booksVersion}`, () =>
    api<MemberCard[]>("/api/members"),
  );
}

export function fetchRegisterPolicy(booksVersion: number) {
  return fetchCached(registerPolicyByVersion, booksVersion, `register-policy:v${booksVersion}`, () =>
    api<RegisterPolicy>("/api/members/register-policy"),
  );
}

export function fetchOpenPeriod(booksVersion: number) {
  return fetchCached(openPeriodByVersion, booksVersion, `open-period:v${booksVersion}`, () =>
    api<{ period: string }>("/api/open-period"),
  );
}

export function fetchNotifications(booksVersion: number) {
  return fetchCached(notificationsByVersion, booksVersion, `notifications:v${booksVersion}`, () =>
    api<NotificationRow[]>("/api/notifications"),
  );
}

export function fetchStaffDashboard(booksVersion: number) {
  return fetchCached(dashboardByVersion, booksVersion, `dashboard:v${booksVersion}`, () =>
    api<StaffDashboard>("/api/dashboard"),
  );
}

export function fetchMemberProfile(booksVersion: number) {
  return fetchCached(memberProfileByVersion, booksVersion, `member-me:v${booksVersion}`, () =>
    api<MemberProfile>("/api/me"),
  );
}

export function fetchReportMonthSheetBootstrap(booksVersion: number) {
  return fetchCached(monthSheetBootstrapByVersion, booksVersion, `report-month-sheet:v${booksVersion}`, () =>
    api<ReportMonthSheetBootstrap>("/api/reports/month-sheet"),
  );
}
