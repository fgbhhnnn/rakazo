import { describe, expect, it } from "vitest";
import { completeTeamRunTool } from "./run-tools-team.js";

describe("complete_team_run", () => {
  it("lets the leader close a task the user stopped as stopped", () => {
    const schema = completeTeamRunTool.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties.outcome?.enum).toEqual(["completed", "stopped"]);
    expect(schema.required).toEqual(["summary"]);
    expect(completeTeamRunTool.description).toContain('outcome "stopped"');
  });
});
