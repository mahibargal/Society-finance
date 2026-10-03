import { Bell, Building2, CalendarCheck, ChevronLeft, ClipboardList, FileText, Home, Landmark, LogOut, Plus, Receipt, Settings, Table2, Users, Wallet, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useBooksVersion } from "../lib/books-refresh";
import { showAddMember } from "../lib/register-setup";
import { fetchMemberCards, fetchNotifications, fetchRegisterPolicy } from "../lib/staff-data";
import { AlertsPanel } from "./alerts-panel";

type NavItem = { to: string; label: string; icon: LucideIcon; hint?: string; end?: boolean };

/** The bottom bar holds the screens used at every meeting. Everything else lives behind the profile button in the header. */
const adminNav: NavItem[] = [
  { to: "/app", label: "Home", icon: Home, hint: "This month at a glance", end: true },
  { to: "/app/members", label: "Members", icon: Users, hint: "Shares, dues and logins" },
  { to: "/app/payments", label: "Payments", icon: Receipt, hint: "Receipts month by month" },
  { to: "/app/loans", label: "Loans", icon: Landmark, hint: "Given and outstanding" },
  { to: "/app/reports", label: "Reports", icon: FileText, hint: "Sheets, loans, interest" },
];

const memberNav: NavItem[] = [
  { to: "/me", label: "Home", icon: Home, hint: "Your account", end: true },
  { to: "/me/payments", label: "Payments", icon: Receipt, hint: "Your receipts" },
  { to: "/me/loan", label: "Loan", icon: Landmark, hint: "What you owe" },
  { to: "/me/interest", label: "Interest + penalty", icon: Wallet, hint: "Pool share you received" },
  { to: "/me/reports", label: "Reports", icon: FileText, hint: "Sheets, loans, penalties" },
];

const platformNav: NavItem[] = [{ to: "/platform", label: "Societies", icon: Building2, hint: "Every society and admin", end: true }];

const adminBooks: NavItem[] = [
  { to: "/app/month-sheet", label: "Month to collect", icon: ClipboardList, hint: "Member dues this month" },
  { to: "/app/month-collected", label: "Month collected", icon: Table2, hint: "Share, interest, principal paid" },
];

const memberBooks: NavItem[] = [
  { to: "/me/my-report", label: "My month report", icon: FileText, hint: "Your history by month" },
  { to: "/me/month-sheet", label: "Month to collect", icon: ClipboardList, hint: "Society dues sheet" },
  { to: "/me/month-collected", label: "Month collected", icon: Table2, hint: "Society receipts sheet" },
];

/** The sidebar keeps the monthly routine. Records that are opened rarely sit in the profile menu. */
const adminSide: NavItem[] = [
  { to: "/app/interest", label: "Interest distribution", icon: Wallet, hint: "Share interest and penalty pool" },
  { to: "/app/close", label: "Close month", icon: CalendarCheck, hint: "Reconcile and open the next" },
  { to: "/app/settings", label: "Settings", icon: Settings, hint: "Society, rate and password" },
];

const memberManage: NavItem[] = [
  { to: "/me/more", label: "Statement and WhatsApp", icon: FileText, hint: "Print or send your statement" },
];

const ROLE_LABELS: Record<string, string> = {
  MAIN_ADMIN: "MAIN ADMIN",
  OWNER: "OWNER",
  ADMIN: "SOCIETY ADMIN",
  MEMBER: "MEMBER",
};

/** Keep touch scroll on the mobile drawer only; iOS otherwise scrolls the page behind it. */
function useMobileScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia("(min-width: 1024px)").matches) return;

    const scrollY = window.scrollY;
    const { body } = document;
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";

    const blockBackgroundScroll = (event: TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-mobile-sidebar-scroll]")) return;
      event.preventDefault();
    };
    document.addEventListener("touchmove", blockBackgroundScroll, { passive: false });

    return () => {
      document.removeEventListener("touchmove", blockBackgroundScroll);
      body.style.position = "";
      body.style.top = "";
      body.style.width = "";
      body.style.overflow = "";
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}

const brandPanel =
  "bg-gradient-to-br from-moss to-[#0d9488] text-white";

function BrandIdentityCard({
  session,
  initials,
  onClose,
  className = "",
}: {
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  initials: string;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <div className={`${brandPanel} ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold tracking-[0.14em] text-white/85">SOCIETY FINANCE</span>
        {onClose && (
          <button type="button" aria-label="Close menu" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/20" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
      <div className="mt-2 flex items-start gap-2.5">
        {session.society.logoUrl
          ? <img src={session.society.logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover ring-2 ring-white/30" />
          : <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/25 text-base font-semibold ring-2 ring-white/30">{initials}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-semibold leading-tight">{session.user.name}</span>
            <span className="shrink-0 rounded-full bg-white/25 px-2 py-0.5 text-[9px] font-bold tracking-[0.08em] text-white">
              {ROLE_LABELS[session.user.role ?? ""] ?? "MEMBER"}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-white/90">{session.society.name}</p>
        </div>
      </div>
    </div>
  );
}

function SideSection({ label, items, onNavigate }: { label: string; items: NavItem[]; onNavigate?: () => void }) {
  return (
    <div className="grid gap-1">
      <div className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-[0.16em] text-moss/70">{label.toUpperCase()}</div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          onClick={() => onNavigate?.()}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-2xl px-2 py-2.5 transition ${isActive ? "bg-white shadow-[0_4px_14px_rgba(15,118,110,0.12)] ring-1 ring-moss/15" : "hover:bg-white/70"}`
          }
        >
          {({ isActive }) => (
            <>
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${isActive ? "bg-moss text-white" : "bg-white/90 text-moss/80 ring-1 ring-moss/10"}`}>
                <item.icon size={17} />
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-sm font-medium ${isActive ? "text-moss" : "text-ink"}`}>{item.label}</span>
                {item.hint && <span className={`block truncate text-xs ${isActive ? "text-moss/70" : "text-muted"}`}>{item.hint}</span>}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </div>
  );
}

function SocietySidebar({
  session,
  initials,
  admin,
  platform,
  nav,
  side,
  onClose,
  onSignOut,
  className = "",
}: {
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  initials: string;
  admin: boolean;
  platform: boolean;
  nav: NavItem[];
  side: NavItem[];
  onClose?: () => void;
  onSignOut: () => void;
  className?: string;
}) {
  const mobileDrawer = Boolean(onClose);
  return (
    <div
      className={`flex h-full w-[260px] max-w-[min(260px,88vw)] flex-col border-r border-moss/15 bg-gradient-to-b from-[#e7efe9] via-[#eef6f2] to-paper ${
        mobileDrawer ? "max-h-[100dvh] overflow-hidden" : "overflow-auto"
      } ${className}`}
    >
      <BrandIdentityCard
        session={session}
        initials={initials}
        onClose={onClose}
        className="mx-2 mt-2 shrink-0 rounded-2xl px-3 py-2.5 shadow-[0_6px_20px_rgba(15,118,110,0.2)]"
      />
      <div
        data-mobile-sidebar-scroll={mobileDrawer ? true : undefined}
        className={`grid flex-1 gap-0.5 px-2 py-2 content-start ${mobileDrawer ? "min-h-0 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]" : ""}`}
      >
        <SideSection label={admin ? "Society" : "Account"} items={nav} onNavigate={onClose} />
        {!platform && <SideSection label="Books" items={admin ? adminBooks : memberBooks} onNavigate={onClose} />}
        {side.length > 0 && <SideSection label="Manage" items={side} onNavigate={onClose} />}
      </div>
      <div className="mt-auto shrink-0 border-t border-moss/10 px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <div className="px-2 text-[11px] text-moss/70">Signed in as {session.user.username}</div>
        <button type="button" className="mt-1.5 flex min-h-10 w-full items-center gap-2 rounded-xl px-2 text-left text-sm font-medium text-clay hover:bg-clay/8" onClick={onSignOut}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-clay/10">
            <LogOut size={16} />
          </span>
          Sign out
        </button>
      </div>
    </div>
  );
}

export function Shell({ children, admin = false, platform = false }: { children: ReactNode; admin?: boolean; platform?: boolean }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [actions, setActions] = useState(false);
  const [profile, setProfile] = useState(false);
  const location = useLocation();
  const home = platform ? "/platform" : admin ? "/app" : "/me";
  const showBack = location.pathname !== home;
  /** Tabs and inner pages go home (or one step up). History.back from Home reopened the login form. */
  function goBack() {
    const path = location.pathname;
    if (path.startsWith("/app/members/") && path !== "/app/members") navigate("/app/members");
    else if (path === "/app/pay") navigate("/app/payments");
    else if (path === "/app/audit" || path === "/app/import") navigate("/app/settings");
    else if (path.startsWith("/app/month-")) navigate("/app");
    else if (path.startsWith("/me/month-") || path === "/me/my-report") navigate("/me");
    else navigate(home);
  }
  const nav = platform ? platformNav : admin ? adminNav : memberNav;
  const side = platform ? [] : admin ? adminSide : memberManage;
  const signOut = () => void logout().then(() => navigate("/"));
  const initials = (session?.user.name ?? "?").trim().charAt(0).toUpperCase();
  const showAlerts = !platform;
  const booksVersion = useBooksVersion();
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [registerOpen, setRegisterOpen] = useState(true);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!admin) {
      setMemberCount(null);
      return;
    }
    fetchMemberCards(booksVersion)
      .then((rows) => setMemberCount(rows.length))
      .catch(() => setMemberCount(0));
    fetchRegisterPolicy(booksVersion)
      .then((policy) => setRegisterOpen(policy.canAddMembers))
      .catch(() => setRegisterOpen(false));
  }, [admin, booksVersion]);
  useEffect(() => {
    if (!showAlerts) return;
    fetchNotifications(booksVersion)
      .then((rows) => setUnread(rows.filter((row) => !row.readAt).length))
      .catch(() => setUnread(0));
  }, [showAlerts, booksVersion]);

  useEffect(() => {
    setProfile(false);
  }, [location.pathname]);

  useMobileScrollLock(Boolean(profile && session));

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="no-print sticky top-0 hidden h-screen lg:block">
        {session && (
          <SocietySidebar
            session={session}
            initials={initials}
            admin={admin}
            platform={platform}
            nav={nav}
            side={side}
            onSignOut={signOut}
            className="h-screen"
          />
        )}
      </aside>
      <div className={`safe-bottom min-w-0 ${profile ? "max-lg:pointer-events-none" : ""}`}>
        <header className="safe-top sticky top-0 z-20 border-b border-moss/15 bg-gradient-to-r from-[#eef6f2] via-[#f8fbf9] to-white backdrop-blur lg:bg-[#f8fbf9]/95">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2.5 lg:gap-3 lg:px-4 lg:py-3">
            <div className="flex min-w-0 items-center gap-2">
              {showBack && (
                <button type="button" aria-label="Back" onClick={goBack} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-paper-deep text-ink">
                  <ChevronLeft size={22} />
                </button>
              )}
              <div className="min-w-0">
                <div className="text-[11px] font-semibold tracking-[0.16em] text-moss">SOCIETY FINANCE</div>
                <div className="max-w-[14rem] truncate text-sm font-medium">{session?.society.name}</div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {showAlerts && (
                <button type="button" aria-label="Alerts" onClick={() => setAlertsOpen(true)} className={`relative grid h-10 w-10 place-items-center rounded-2xl ${alertsOpen ? "bg-moss text-white" : "bg-paper-deep text-ink"}`}>
                  <Bell size={20} />
                  {unread > 0 && (
                    <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-clay px-1 text-[10px] font-semibold text-white">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </button>
              )}
              <button type="button" aria-label="Profile and menu" onClick={() => setProfile(true)} className={`grid h-10 w-10 place-items-center overflow-hidden rounded-2xl text-sm font-semibold text-white lg:hidden ${profile ? "ring-2 ring-moss ring-offset-2" : ""} bg-moss`}>
                {session?.society.logoUrl
                  ? <img src={session.society.logoUrl} alt="" className="h-full w-full object-cover" />
                  : initials}
              </button>
            </div>
          </div>
        </header>
        {/* Wide report tables must scroll inside their card, not stretch the page under the fixed tab bar. */}
        <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5 [&>*]:min-w-0">{children}</main>
      </div>

      <nav className="tab-bar no-print fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-[#eef6f2]/95 to-transparent pt-2 lg:hidden">
        <div className="mx-2 mb-[calc(0.35rem+env(safe-area-inset-bottom))] grid rounded-[22px] border border-moss/20 bg-white p-1 shadow-[0_8px_28px_rgba(15,118,110,0.18)]" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-[18px] font-semibold transition ${nav.length > 4 ? "text-[10px]" : "text-[11px]"} ${isActive ? "bg-moss text-white shadow-[0_4px_12px_rgba(15,118,110,0.35)]" : "text-moss/75 active:bg-moss/5"}`}
            >
              {({ isActive }) => (
                <>
                  <item.icon size={20} strokeWidth={isActive ? 2.4 : 1.9} />
                  <span className="w-full truncate px-0.5 text-center">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} onCountChange={setUnread} />

      {profile && session && (
        <div className="no-print fixed inset-0 z-50 overflow-hidden lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-moss/30 backdrop-blur-[3px]"
            onClick={() => setProfile(false)}
          />
          <div className="safe-top absolute inset-y-0 right-0 flex max-h-[100dvh] shadow-2xl">
            <SocietySidebar
              session={session}
              initials={initials}
              admin={admin}
              platform={platform}
              nav={nav}
              side={side}
              onClose={() => setProfile(false)}
              onSignOut={signOut}
              className="h-full max-h-[100dvh]"
            />
          </div>
        </div>
      )}

      {admin && (
        <>
          <button type="button" aria-label="Quick actions" className="no-print fixed right-5 bottom-[calc(6.4rem+env(safe-area-inset-bottom))] z-40 grid h-14 w-14 place-items-center rounded-full bg-moss text-white shadow-[0_12px_30px_rgba(15,118,110,0.35)] lg:right-8 lg:bottom-8" onClick={() => setActions(true)}>
            <Plus />
          </button>
          {actions && (
            <div className="fixed inset-0 z-50 flex items-end bg-moss/25 p-3 backdrop-blur-[2px] lg:items-center lg:justify-center" onClick={() => setActions(false)}>
              <div className="w-full max-w-md rounded-[28px] bg-white p-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
                {[
                  ["Collect payment", "/app/pay"],
                  ["Month to collect", "/app/month-sheet"],
                  ["Month collected", "/app/month-collected"],
                  ["Add member", "/app/members?new=1"],
                  ["Create loan", "/app/loans?new=1"],
                ]
                  .filter(([label]) => label !== "Add member" || memberCount === null || showAddMember(memberCount, registerOpen))
                  .map(([label, to]) => (
                  <button key={to} type="button" className="flex min-h-14 w-full items-center rounded-2xl px-4 text-left text-base hover:bg-paper" onClick={() => { setActions(false); navigate(to); }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export type IconType = LucideIcon;
