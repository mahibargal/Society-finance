export class ApiError extends Error {
  details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

const NETWORK_MESSAGE =
  "Could not reach the server. If you use dev mode, run the API on port 4000 and open the app at http://127.0.0.1:5173 — or use npm run start -w server and refresh.";

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, { ...options, credentials: "include", cache: "no-store" });
  } catch (err) {
    if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message)) {
      throw new ApiError(NETWORK_MESSAGE);
    }
    throw err instanceof Error ? err : new ApiError("Network error");
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
    if (!response.ok) throw new ApiError("The request failed");
    return response as T;
  }
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.message ?? "The request failed", data.details);
  return data as T;
}
