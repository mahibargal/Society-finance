import { useRef } from "react";
import { Button } from "./ui";

type Format = "pdf" | "xlsx";

export function ExportDownloadButtons({
  downloading,
  onDownload,
  className = "",
}: {
  downloading: "" | Format;
  onDownload: (format: Format) => void;
  className?: string;
}) {
  const busy = downloading !== "";
  const tapLock = useRef(false);

  function tap(format: Format) {
    if (busy || tapLock.current) return;
    tapLock.current = true;
    window.setTimeout(() => {
      tapLock.current = false;
    }, 800);
    onDownload(format);
  }

  return (
    <div className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <Button
        tone="primary"
        className="min-h-11 px-4 py-3 text-sm"
        disabled={busy}
        loading={downloading === "xlsx"}
        loadingLabel="Downloading Excel…"
        onClick={() => tap("xlsx")}
      >
        Excel
      </Button>
      <Button
        tone="ghost"
        className="min-h-11 px-4 py-3 text-sm"
        disabled={busy}
        loading={downloading === "pdf"}
        loadingLabel="Downloading PDF…"
        onClick={() => tap("pdf")}
      >
        PDF
      </Button>
    </div>
  );
}
