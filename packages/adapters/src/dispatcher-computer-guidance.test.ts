import type { BrowserProvider, SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import {
  dispatcherComputerGuidance,
  workerPageBrowserAllowed,
} from "./dispatcher-computer-guidance.js";
import { userTurnInstructions } from "./run-instructions.js";

describe("dispatcher worker computer capability", () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])("requires graphical=%s and page=%s", (graphical, page, expected) => {
    const provision = vi.fn();
    const sandbox = {
      describe: () => ({ capabilities: { graphical } }),
      provision,
    } as unknown as SandboxProvider;
    const browser = { describe: () => ({ capabilities: { page } }) } as unknown as BrowserProvider;
    expect(workerPageBrowserAllowed(sandbox, browser)).toBe(expected);
    expect(provision).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses the same sandbox pageBrowser capability as worker runs (%s)",
    (page) => {
      const sandbox = {
        describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
        ...(page ? { pageBrowser: vi.fn() } : {}),
      } as unknown as SandboxProvider;
      expect(workerPageBrowserAllowed(sandbox, new ComputerBrowserProvider({ sandbox }))).toBe(
        page,
      );
    },
  );

  it("adds worker capability guidance only to dispatcher turns", () => {
    const parts = {
      botInstructions: "Bot",
      groupContext: undefined,
      messagingContext: undefined,
      redactedMemoryContext: undefined,
      redactedScratchpadContext: undefined,
      hasHistoricalContext: false,
      computerInstruction: "Computer",
      pageBrowserAllowed: false,
      workspaceInstruction: "Workspace",
      agentEnvironmentInstruction: undefined,
      botDirectory: undefined,
      pluginLine: undefined,
      agentSkillsLine: undefined,
      taughtSkillsLine: undefined,
      replyGuidance: "Reply",
    };
    for (const page of [false, true]) {
      const clause = dispatcherComputerGuidance(page);
      expect(
        userTurnInstructions({ ...parts, dispatcherRun: true, workerPageBrowserAllowed: page }),
      ).toContain(clause);
      expect(
        userTurnInstructions({ ...parts, dispatcherRun: false, workerPageBrowserAllowed: page }),
      ).not.toContain(clause);
    }
    expect(dispatcherComputerGuidance(undefined)).toBe(dispatcherComputerGuidance(false));
  });
});
