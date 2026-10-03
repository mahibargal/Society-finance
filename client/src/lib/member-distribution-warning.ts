import { api } from "./api";

export async function confirmMemberDistributionChange(action: "deactivate" | "activate" | "add", memberId?: string) {
  const params = new URLSearchParams({ action });
  if (memberId) params.set("memberId", memberId);
  const warning = await api<{ needsConfirmation: boolean; blocked?: boolean; message: string }>(`/api/members/distribution-warning?${params}`);
  if (warning.blocked && warning.message) {
    window.alert(warning.message);
    return false;
  }
  if (!warning.needsConfirmation) return true;
  return window.confirm(warning.message);
}
