const IMPORT_DRAFT_KEY = "society.importDraft";

export type ImportDraft = {
  period: string;
  fileName: string;
  preview: Record<string, unknown>;
};

export function saveImportDraft(draft: ImportDraft) {
  try {
    sessionStorage.setItem(IMPORT_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* private mode */
  }
}

export function loadImportDraft(): ImportDraft | null {
  try {
    const raw = sessionStorage.getItem(IMPORT_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImportDraft;
    if (!parsed?.period || !parsed?.preview?.rows) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearImportDraft() {
  try {
    sessionStorage.removeItem(IMPORT_DRAFT_KEY);
  } catch {
    /* private mode */
  }
}
