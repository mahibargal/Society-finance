const RETRY_CODES = new Set(["P1001", "P1017"]);

export function isDbConnectionError(error: unknown): boolean {
  if (typeof error === "object" && error && "code" in error) {
    if (RETRY_CODES.has(String((error as { code: string }).code))) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Server has closed the connection|Can't reach database server|Connection refused|connect ECONNREFUSED|starting up|Connection reset/i.test(message);
}

export async function withDbReconnect<T>(run: () => Promise<T>): Promise<T> {
  const { reconnectPrisma } = await import("./prisma.js");
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!isDbConnectionError(error) || attempt === 3) throw error;
      await reconnectPrisma();
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw last;
}
