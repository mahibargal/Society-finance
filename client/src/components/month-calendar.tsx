import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { monthLabel } from "../lib/format";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function periodOf(year: number, monthIndex: number) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

export function MonthCalendar({
  value,
  periods,
  onChange,
  label = "Month",
}: {
  value: string;
  periods: string[];
  onChange: (period: string) => void;
  label?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const allowed = new Set(periods);
  const years = periods.map((period) => Number(period.slice(0, 4))).filter((year) => year > 0);
  const minYear = years.length ? Math.min(...years) : new Date().getFullYear();
  const maxYear = years.length ? Math.max(...years) : minYear;
  const selectedYear = Number(value.slice(0, 4)) || maxYear;
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(selectedYear);

  useEffect(() => {
    if (value) setViewYear(Number(value.slice(0, 4)) || maxYear);
  }, [value, maxYear]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative mt-3">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      <button
        type="button"
        className="mt-1 flex min-h-12 w-full items-center justify-between rounded-2xl border border-line bg-white px-3 text-left"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{value ? monthLabel(value) : "Choose month"}</span>
        <CalendarDays className="h-5 w-5 text-moss" aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose month"
          className="absolute z-30 mt-2 w-full rounded-2xl border border-line bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)]"
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-xl border border-line disabled:opacity-40"
              disabled={viewYear <= minYear}
              aria-label="Previous year"
              onClick={() => setViewYear((year) => year - 1)}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="text-base font-semibold">{viewYear}</div>
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-xl border border-line disabled:opacity-40"
              disabled={viewYear >= maxYear}
              aria-label="Next year"
              onClick={() => setViewYear((year) => year + 1)}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {SHORT.map((name, index) => {
              const period = periodOf(viewYear, index);
              const selected = period === value;
              const enabled = allowed.has(period);
              return (
                <button
                  key={period}
                  type="button"
                  disabled={!enabled}
                  onClick={() => {
                    onChange(period);
                    setOpen(false);
                  }}
                  className={`min-h-11 rounded-xl text-sm font-semibold ${
                    selected
                      ? "bg-pine text-white"
                      : enabled
                        ? "bg-paper text-ink hover:bg-moss/10"
                        : "cursor-not-allowed text-muted/40"
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
