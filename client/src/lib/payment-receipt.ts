import { downloadFromResponse } from "./download-blob";

export function receiptPdfFilename(receiptNo: string) {
  const base = receiptNo.replace(/[^\w.-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "receipt";
  return `${base}.pdf`;
}

export async function downloadPaymentReceipt(paymentId: string, receiptNo: string) {
  const response = await fetch(`/api/payments/${encodeURIComponent(paymentId)}/receipt`, {
    credentials: "include",
    cache: "no-store",
  });
  await downloadFromResponse(response, receiptPdfFilename(receiptNo));
}
