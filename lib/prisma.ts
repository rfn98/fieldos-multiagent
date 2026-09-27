import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __fieldosPrisma?: PrismaClient };

export const prisma = globalForPrisma.__fieldosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__fieldosPrisma = prisma;
}