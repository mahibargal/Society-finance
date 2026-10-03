function mobileLike() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function filenameFromDisposition(header: string | null, fallback: string) {
  const named = /filename="?([^";]+)"?/i.exec(header ?? "");
  return named?.[1] ?? fallback;
}

/** Download or open a blob without navigating the app away (common mobile PDF blank-screen bug). */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const isPdf = /\.pdf$/i.test(filename) || blob.type.includes("pdf");
  const openPdfInNewTab = isPdf && mobileLike();

  if (openPdfInNewTab) {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export async function downloadFromResponse(response: Response, fallbackFilename: string) {
  if (!response.ok) {
    let message = "The download could not be completed";
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (data.message) message = data.message;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition"), fallbackFilename);
  const looksPdf = /\.pdf$/i.test(filename) || (blob.type || "").includes("pdf");
  if (looksPdf && blob.size >= 4) {
    const sig = new TextDecoder().decode(await blob.slice(0, 4).arrayBuffer());
    if (!sig.startsWith("%PDF")) throw new Error("The server did not return a PDF. Sign in again or refresh the page.");
  }
  saveBlob(blob, filename);
}
