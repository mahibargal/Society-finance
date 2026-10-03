import { useRef, useState } from "react";

export type DownloadFormat = "pdf" | "xlsx";

export function useFormatDownload() {
  const [downloading, setDownloading] = useState<"" | DownloadFormat>("");
  const inFlight = useRef(false);

  async function run(format: DownloadFormat, task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setDownloading(format);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setDownloading("");
    }
  }

  return { downloading, run };
}
