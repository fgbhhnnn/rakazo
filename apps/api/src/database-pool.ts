import { parsePositiveInteger } from "@rakazo/db";

/** Per API process; leave headroom for content keys, listeners and rolling deploys. */
export function apiDatabasePoolMax(env: { DB_POOL_MAX?: string } = process.env): number {
  return parsePositiveInteger(env.DB_POOL_MAX, 12);
}
