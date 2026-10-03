export class ApiError extends Error {
  details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

const DEV_NETWORK_HINT =
  "Dev tip: run the API on port 4000 and open http://127.0.0.1:5173, or use npm run start -w server and refresh.";

function networkErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message.trim() : "";
  const genericFetch = !raw || /failed to fetch|networkerror|load failed|network request failed/i.test(raw);
  if (import.meta.env.DEV) {
    if (genericFetch) return `Could not reach the server. ${DEV_NETWORK_HINT}`;
    return `${raw} ${DEV_NETWORK_HINT}`;
  }
  if (genericFetch) {
    return "Could not reach the server. Check your connection and try again in a moment.";
  }
  return raw;
}

async function errorMessageFromResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    if (data.message) return data.message;
  } else {
    const text = (await response.text().catch(() => "")).trim();
    if (text && text.length < 300 && !text.startsWith("<!")) return text;
  }
  const label = response.statusText ? ` ${response.statusText}` : "";
  return `Request failed (${response.status}${label})`;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, { ...options, credentials: "include", cache: "no-store" });
  } catch (err) {
    if (err instanceof TypeError && /failed to fetch|networkerror|load failed|network request failed/i.test(err.message)) {
      throw new ApiError(networkErrorMessage(err));
    }
    throw err instanceof Error ? err : new ApiError(networkErrorMessage(err));
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await apiFetch(path, { ...options, headers });
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) throw new ApiError(await errorMessageFromResponse(response));
    return response as T;
  }
  const data = await response.json();
  if (!response.ok) {
    const fallback =
      response.statusText.trim().length > 0
        ? `Request failed (${response.status} ${response.statusText})`
        : `Request failed (${response.status})`;
    throw new ApiError(data.message ?? fallback, data.details);
  }
  return data as T;
}
