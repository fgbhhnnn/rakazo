import { expect, it } from "vitest";
import { AGENT_IMPORT_ENABLED } from "./agent-import-flag";

it("keeps agent import off on this deployment", () => {
  // Turning this on also needs RAKAZO_AGENT_IMPORT_ENABLED=true on the server.
  expect(AGENT_IMPORT_ENABLED).toBe(false);
});
