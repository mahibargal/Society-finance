/** Shown when the open month already has a receipt for this member (any amount, including ₹0). */
export const PAYMENT_ALREADY_COLLECTED_MESSAGE =
  "Payment already collected for this month. If you want to add another payment, delete the previous payment in Payments, then collect again.";

export function alertPaymentAlreadyCollected() {
  window.alert(PAYMENT_ALREADY_COLLECTED_MESSAGE);
}

export function memberHasReceiptThisOpenMonth(member: { collectedThisOpenMonth?: boolean } | undefined) {
  return member?.collectedThisOpenMonth === true;
}

function isSafeInAppPath(path: string) {
  return (path.startsWith("/app") || path.startsWith("/me")) && !path.includes("//");
}

/** Where to go after collect or when leaving /app/pay (from ?returnTo= or navigation state). */
export function collectPaymentReturnTo(state: unknown, search: string) {
  const fromState = (state as { returnTo?: string } | null)?.returnTo?.trim();
  if (fromState && isSafeInAppPath(fromState)) return fromState;
  const fromQuery = new URLSearchParams(search).get("returnTo")?.trim();
  if (fromQuery && isSafeInAppPath(fromQuery)) return fromQuery;
  return null;
}
