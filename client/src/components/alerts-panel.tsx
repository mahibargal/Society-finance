import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { downloadPaymentReceipt } from "../lib/payment-receipt";
import { Bone, Empty } from "./ui";

export type Alert = {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
  type?: string;
  receiptDownload?: { paymentId: string; receiptNo: string } | null;
};

function whenLabel(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return `Today ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function AlertsPanel({ open, onClose, onCountChange }: { open: boolean; onClose: () => void; onCountChange: (unread: number) => void }) {
  const [rows, setRows] = useState<Alert[] | null>(null);
  const [downloading, setDownloading] = useState("");
  const [downloadError, setDownloadError] = useState("");
  useEffect(() => {
    if (!open) return;
    setRows(null);
    api<Alert[]>("/api/notifications")
      .then((list) => { setRows(list); onCountChange(list.filter((row) => !row.readAt).length); })
      .catch(() => setRows([]));
  }, [open]);

  const markRead = async (ids: string[]) => {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => api(`/api/notifications/${id}/read`, { method: "POST" })));
    setRows((current) => {
      const next = (current ?? []).map((row) => (ids.includes(row.id) ? { ...row, readAt: new Date().toISOString() } : row));
      onCountChange(next.filter((row) => !row.readAt).length);
      return next;
    });
  };

  if (!open) return null;
  const unread = (rows ?? []).filter((row) => !row.readAt);
  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end bg-ink/40" onClick={onClose}>
      <aside
        className="safe-top flex h-full w-full max-w-sm flex-col bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <div className="text-lg font-semibold">Alerts</div>
            <div className="text-xs text-muted">{unread.length > 0 ? `${unread.length} unread` : "All caught up"}</div>
          </div>
          <div className="flex items-center gap-2">
            {unread.length > 0 && (
              <button type="button" className="min-h-10 rounded-2xl border border-line px-3 text-sm font-semibold" onClick={() => void markRead(unread.map((row) => row.id))}>
                Mark all read
              </button>
            )}
            <button type="button" aria-label="Close alerts" className="grid h-10 w-10 place-items-center rounded-full bg-paper-deep" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {rows === null && (
            <div className="grid gap-2">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="rounded-2xl border border-line p-3">
                  <Bone className="h-4 w-2/3 rounded-lg" />
                  <Bone className="mt-2 h-3 w-full rounded-lg" />
                  <Bone className="mt-2 h-3 w-1/3 rounded-lg" />
                </div>
              ))}
            </div>
          )}
          {downloadError && <p className="mb-2 text-sm text-clay">{downloadError}</p>}
          {rows !== null && rows.length === 0 && (
            <Empty title="No alerts found" body="Receipts, distributions and month closings appear here." />
          )}
          <div className="grid gap-2">
            {(rows ?? []).map((row) => (
              <div
                key={row.id}
                role="button"
                tabIndex={0}
                onClick={() => void markRead([row.id])}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void markRead([row.id]);
                  }
                }}
                className={`rounded-2xl border p-3 text-left ${row.readAt ? "border-line bg-white" : "border-moss bg-paper"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">{row.title}</div>
                  {!row.readAt && <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-moss" />}
                </div>
                <p className="mt-1 text-sm text-muted">{row.body}</p>
                {row.receiptDownload && (
                  <button
                    type="button"
                    className="mt-2 min-h-10 rounded-2xl border border-moss bg-white px-3 text-sm font-semibold text-moss"
                    disabled={downloading === row.receiptDownload.paymentId}
                    onClick={(event) => {
                      event.stopPropagation();
                      const { paymentId, receiptNo } = row.receiptDownload!;
                      setDownloadError("");
                      setDownloading(paymentId);
                      downloadPaymentReceipt(paymentId, receiptNo)
                        .catch((err) => setDownloadError(err instanceof Error ? err.message : "Could not download receipt"))
                        .finally(() => setDownloading(""));
                    }}
                  >
                    {downloading === row.receiptDownload.paymentId ? "Preparing PDF…" : "Download receipt"}
                  </button>
                )}
                <div className="mt-2 text-xs text-muted">{whenLabel(row.createdAt)}</div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
