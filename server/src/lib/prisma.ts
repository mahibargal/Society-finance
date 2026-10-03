import { PrismaClient } from "@prisma/client";
import { withDbReconnect } from "./db-connection.js";

const client = new PrismaClient();

export async function reconnectPrisma() {
  await client.$disconnect().catch(() => undefined);
  const { recoverDatabase } = await import("../db/ensure.js");
  await recoverDatabase();
}

export const prisma = client.$extends({
  query: {
    $allOperations({ query, args }) {
      return withDbReconnect(() => query(args));
    },
  },
}) as unknown as PrismaClient;
