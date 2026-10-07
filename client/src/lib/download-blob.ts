function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isAndroid() {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

function filenameFromDisposition(header: string | null, fallback: string) {
  const named = /filename="?([^";]+)"?/i.exec(header ?? "");
  return named?.[1] ?? fallback;
}

/** Android often saves twice if window.open(blob) and <a download> both run — guard identical saves. */
let lastSaveKey = "";
let lastSaveAt = 0;

function shouldSkipDuplicateSave(filename: string) {
  const key = filename;
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 2500) return true;
  lastSaveKey = key;
  lastSaveAt = now;
  return false;
}

function triggerAnchorDownload(url: string, filename: string, targetBlank = false) {
  const link = document.createElement("a");
  link.href = url;
  link.style.display = "none";
  if (targetBlank) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  } else {
    link.download = filename;
  }
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function iosShareFile(blob: Blob, filename: string) {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    const file = new File([blob], filename, {
      type: blob.type || "application/octet-stream",
    });
    if (!navigator.canShare({ files: [file] })) return false;
    void navigator.share({ files: [file] });
    return true;
  } catch {
    return false;
  }
}

/** Download or open a blob without navigating the SPA away (iOS Safari navigates in-place on `<a download>`). */
export function saveBlob(blob: Blob, filename: string) {
  if (shouldSkipDuplicateSave(filename)) return;

  const url = URL.createObjectURL(blob);
  const isPdf = /\.pdf$/i.test(filename) || blob.type.includes("pdf");
  const ios = isIos() && !isAndroid();

  if (ios && !isPdf && iosShareFile(blob, filename)) {
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
    return;
  }

  /** iOS: new tab (or share above) — in-tab blob navigation breaks back to Reports. Android: <a download> once. */
  const openInNewTab = ios;

  if (openInNewTab) {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) triggerAnchorDownload(url, filename, true);
  } else {
    triggerAnchorDownload(url, filename, false);
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
