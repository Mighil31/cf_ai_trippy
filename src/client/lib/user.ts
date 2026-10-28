const KEY = "trippy:userId";

let fallbackId: string | null = null;

/**
 * Anonymous user id, kept in localStorage. If storage is unavailable (private
 * mode, blocked site data) the id lasts for this page load only.
 */
export function getUserId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    fallbackId ??= crypto.randomUUID();
    return fallbackId;
  }
}
