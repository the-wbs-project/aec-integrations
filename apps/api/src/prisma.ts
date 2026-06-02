import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';

import type { Env } from './env';

export type AcceleratedPrisma = ReturnType<typeof getPrisma>;

export function getPrisma(env: Env) {
  return new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
  }).$extends(withAccelerate());
}
