const MANUAL_MEMBERS_KEY = "society.allowManualMembers";

export function manualMembersAllowed() {
  try {
    return sessionStorage.getItem(MANUAL_MEMBERS_KEY) === "1";
  } catch {
    return false;
  }
}

export function allowManualMembers() {
  try {
    sessionStorage.setItem(MANUAL_MEMBERS_KEY, "1");
  } catch {
    /* private mode */
  }
}

export function clearManualMembersChoice() {
  try {
    sessionStorage.removeItem(MANUAL_MEMBERS_KEY);
  } catch {
    /* private mode */
  }
}

/** Empty register — show import and manual setup until someone is on the books. */
export function registerNeedsSetup(memberCount: number) {
  return memberCount === 0;
}

/** Add member is allowed only before the first month close (import or manual register). */
export function showAddMember(memberCount: number, canAddMembers: boolean) {
  if (!canAddMembers) return false;
  if (memberCount === 0) return manualMembersAllowed();
  return true;
}

export function addMembersBlockedMessage(importedRegister: boolean) {
  if (importedRegister) {
    return "This society was set up from an imported Excel register. New members cannot be added in the app.";
  }
  return "New members cannot be added after the first month has been closed.";
}
