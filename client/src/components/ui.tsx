import type { ComponentPropsWithoutRef, MouseEventHandler, ReactNode } from "react";
import { formatINR } from "../lib/format";

export function Money({ value, className = "" }: { value: string; className?: string }) {
  return <span className={`num ${className}`}>{formatINR(value)}</span>;
}

export function Card({ children, className = "", ...props }: { children: ReactNode; className?: string } & ComponentPropsWithoutRef<"section">) {
  return (
    <section className={`rounded-[20px] border border-line bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.04)] ${className}`} {...props}>
      {children}
    </section>
  );
}

/** Buttons size to their label. Grid and flex parents stretch them, so forms still get a full-width action. */
export function Button({
  children,
  onClick,
  type = "button",
  tone = "primary",
  disabled,
  loading = false,
  loadingLabel = "Please wait…",
  full = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  type?: "button" | "submit";
  tone?: "primary" | "ghost" | "danger" | "gold";
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  full?: boolean;
  className?: string;
}) {
  const tones = {
    primary: "bg-pine text-white",
    ghost: "bg-white text-ink border border-line",
    danger: "bg-clay text-white",
    gold: "bg-gold text-white",
  };
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      aria-busy={loading}
      className={`min-h-12 rounded-2xl px-5 text-base font-semibold transition active:scale-[0.98] disabled:opacity-50 ${full ? "w-full" : ""} ${tones[tone]} ${className}`}
    >
      {loading ? loadingLabel : children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  inputMode,
  selectOnFocus = false,
  disabled = false,
  title,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  inputMode?: "decimal" | "numeric" | "text" | "tel";
  selectOnFocus?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="block" title={title}>
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        onFocus={(event) => { if (selectOnFocus && !disabled) event.currentTarget.select(); }}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-12 w-full rounded-2xl border border-line px-4 text-base outline-none focus:border-moss ${disabled ? "cursor-not-allowed bg-paper text-muted" : "bg-white"}`}
      />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="grid rounded-2xl bg-paper-deep/70 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={`min-h-10 rounded-xl text-sm font-medium ${value === option.id ? "bg-white text-ink shadow-sm" : "text-muted"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-pine/40 p-3 lg:items-center" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-lg overflow-auto rounded-[28px] bg-card p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">{title}</h2>
          <button type="button" className="min-h-10 rounded-full px-3 text-sm text-muted" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PayoutBadge({ mode }: { mode: string }) {
  const cash = mode === "Cash" || mode === "CASH" || mode === "PAID_CASH";
  return (
    <span
      className={`inline-flex shrink-0 rounded-xl px-2.5 py-0.5 text-xs font-semibold ${
        cash ? "border border-line bg-paper text-ink" : "bg-moss/15 text-moss"
      }`}
    >
      {cash ? "Cash" : "Share"}
    </span>
  );
}

export function Stat({ label, value, hint, large }: { label: string; value: string; hint?: string; large?: boolean }) {
  return (
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className={`num mt-1 ${large ? "text-4xl" : "text-2xl"}`}>{formatINR(value)}</div>
      {hint ? <div className="mt-1 text-sm text-muted">{hint}</div> : null}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}

export function Bone({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function ListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index}>
          <div className="flex items-start justify-between gap-3">
            <div className="grid flex-1 gap-2">
              <Bone className="h-5 w-2/3 rounded-lg" />
              <Bone className="h-3 w-1/2 rounded-lg" />
            </div>
            <Bone className="h-8 w-20 rounded-lg" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Bone className="h-10 rounded-lg" />
            <Bone className="h-10 rounded-lg" />
            <Bone className="h-10 rounded-lg" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="mt-4 grid gap-2">
      <Bone className="h-4 w-full rounded-lg" />
      {Array.from({ length: rows }, (_, index) => (
        <Bone key={index} className="h-10 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function PageSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <>
      <Bone className="h-8 w-44 rounded-lg" />
      <Bone className="h-4 w-56 rounded-lg" />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index}>
            <Bone className="h-3 w-20 rounded-lg" />
            <Bone className="mt-3 h-8 w-28 rounded-lg" />
          </Card>
        ))}
      </div>
      <ListSkeleton count={cards} />
    </>
  );
}

export function ScreenSkeleton() {
  return (
    <div className="grid min-h-screen place-items-center bg-paper px-6">
      <div className="grid w-full max-w-sm gap-3">
        <Bone className="mx-auto h-8 w-40 rounded-lg" />
        <Bone className="h-28 w-full rounded-[20px]" />
        <Bone className="h-28 w-full rounded-[20px]" />
        <Bone className="h-12 w-full rounded-2xl" />
      </div>
    </div>
  );
}
