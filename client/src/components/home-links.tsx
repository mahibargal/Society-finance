import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {action}
    </div>
  );
}

export function FeatureLink({
  to,
  title,
  hint,
  icon: Icon,
  primary = false,
}: {
  to: string;
  title: string;
  hint: string;
  icon?: LucideIcon;
  primary?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`group flex min-h-[4.25rem] items-center gap-3 rounded-[22px] px-4 py-3 transition active:scale-[0.99] ${
        primary
          ? "bg-moss text-white shadow-[0_10px_28px_rgba(15,118,110,0.28)]"
          : "border border-line bg-card shadow-[0_6px_20px_rgba(15,23,42,0.04)] hover:border-moss/30"
      }`}
    >
      {Icon && (
        <span
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${
            primary ? "bg-white/15 text-white" : "bg-paper-deep text-moss"
          }`}
        >
          <Icon size={22} strokeWidth={2} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block font-semibold ${primary ? "text-lg" : "text-base text-ink"}`}>{title}</span>
        <span className={`block text-sm ${primary ? "text-white/80" : "text-muted"}`}>{hint}</span>
      </span>
      <ChevronRight
        size={20}
        className={`shrink-0 transition group-hover:translate-x-0.5 ${primary ? "text-white/70" : "text-muted"}`}
      />
    </Link>
  );
}

export function QuickTile({
  to,
  title,
  hint,
  icon: Icon,
  highlight = false,
}: {
  to: string;
  title: string;
  hint: string;
  icon: LucideIcon;
  highlight?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`flex min-h-[5rem] flex-col justify-between rounded-[22px] p-4 transition active:scale-[0.99] ${
        highlight
          ? "bg-moss text-white shadow-[0_10px_28px_rgba(15,118,110,0.25)]"
          : "border border-line bg-card shadow-[0_6px_20px_rgba(15,23,42,0.04)] hover:border-moss/25"
      }`}
    >
      <Icon size={22} className={highlight ? "text-white/90" : "text-moss"} strokeWidth={2} />
      <span>
        <span className={`block font-semibold ${highlight ? "text-lg" : ""}`}>{title}</span>
        <span className={`mt-0.5 block text-sm ${highlight ? "text-white/75" : "text-muted"}`}>{hint}</span>
      </span>
    </Link>
  );
}
