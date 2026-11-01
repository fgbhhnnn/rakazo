import { describe, expect, it } from "vitest";
import { apiDatabasePoolMax } from "./database-pool.js";

describe("API database pool", () => {
  it("defaults to twelve connections and honors the existing setting", () => {
    expect(apiDatabasePoolMax({})).toBe(12);
    expect(apiDatabasePoolMax({ DB_POOL_MAX: "24" })).toBe(24);
    expect(apiDatabasePoolMax({ DB_POOL_MAX: "4" })).toBe(4);
  });
  it.each(["", "0", "-1", "invalid", "1.5"])("rejects invalid sizes: %s", (DB_POOL_MAX) => {
    expect(apiDatabasePoolMax({ DB_POOL_MAX })).toBe(12);
  });
});
