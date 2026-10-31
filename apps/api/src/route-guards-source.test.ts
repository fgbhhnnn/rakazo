import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards that only real data exercises (hidden workers, card answers, Pages, the shared
 * owner model) are pinned here at the source of each procedure in routes/*.ts, so a merge
 * that drops one fails CI instead of shipping.
 */

const routesDir = join(import.meta.dirname, "routes");
const sources = readdirSync(routesDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => readFileSync(join(routesDir, file), "utf8"));

/** The handler call of one procedure, e.g. `authed.bots.get.handler(...)`, matched by parens. */
function procedureSource(path: string): { root: string; body: string } {
  for (const source of sources) {
    const match = new RegExp(`\\b(\\w+)\\.${path.replaceAll(".", "\\.")}\\.handler\\(`).exec(
      source,
    );
    if (!match) continue;
    let depth = 0;
    let quote: string | null = null;
    for (let index = match.index + match[0].length - 1; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) {
        return { root: match[1] ?? "", body: source.slice(match.index, index + 1) };
      }
    }
  }
  throw new Error(`procedure ${path} not found in routes/*.ts`);
}

function functionSource(name: string): string {
  for (const source of sources) {
    const start = source.search(new RegExp(`export (async )?function ${name}\\(`));
    if (start < 0) continue;
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end);
  }
  throw new Error(`function ${name} not found in routes/*.ts`);
}

const REQUIRED: Record<string, { root: string; tokens: string[] }> = {
  "threads.answer": {
    root: "authed",
    tokens: [
      "answerComputerRestartPrompt(",
      "answerWorkerApprovalMirror(",
      "approvalAnswerPermission(",
      "mayChangeApprovalRules,",
      "approvalRulesLockedError(",
    ],
  },
  "approvalRules.set": { root: "ownerManaged", tokens: ["saveApprovalRule("] },
  "approvalRules.remove": { root: "ownerManaged", tokens: ["removeApprovalRule("] },
  // A member's own approval mode stays theirs on a locked deployment; it saves for the actor only.
  "autoReview.set": {
    root: "authed",
    tokens: [
      "saveAutoReviewPreference(",
      "context.actor,",
      "loadAutoReviewSettings(deps, context.actor",
    ],
  },
  "pages.list": { root: "authed", tokens: ["repos.getBot(", "listOwnedPages("] },
  "pages.get": { root: "authed", tokens: ["getOwnedPage("] },
  "pages.update": { root: "authed", tokens: ["updateOwnedPage("] },
  "models.list": { root: "authed", tokens: ["sharedModelScope(", "withinScope("] },
  "voice.status": { root: "authed", tokens: ["sharedVoiceScope("] },
  "voice.voices": { root: "authed", tokens: ["voiceProviderFor(deps, row.actor"] },
  "deployment.get": {
    root: "authed",
    tokens: ["isDeploymentAdmin(context.actor)", 'ORPCError("FORBIDDEN")', "deploymentDto("],
  },
  "deployment.update": {
    root: "authed",
    tokens: [
      "isDeploymentAdmin(context.actor)",
      'ORPCError("FORBIDDEN")',
      "memberAndSignupCheckUpdate(",
      "deploymentDto(",
    ],
  },
  "spaceSettings.setOverride": { root: "authed", tokens: ["assertMemberSettingsUnlocked("] },
};

describe("route guards at the source", () => {
  it.each(Object.entries(REQUIRED))("%s keeps its guard", (path, { root, tokens }) => {
    const procedure = procedureSource(path);
    expect(procedure.root).toBe(root);
    for (const token of tokens) expect(procedure.body, token).toContain(token);
  });

  // Hidden background workers are never opened as chats (hidden-worker-access.ts).
  it.each(["bootstrap", "bots.get"])("%s never serves a hidden worker", (path) => {
    expect(procedureSource(path).body).not.toContain("includeHidden");
  });

  it("autoReview.set never takes a user from its input", () => {
    const body = procedureSource("autoReview.set").body;
    expect(body).not.toMatch(/input\.(userId|spaceId|actor)/);
  });

  it("an admin check runs before anything else in deployment.update", () => {
    const body = procedureSource("deployment.update").body;
    expect(body.indexOf("isDeploymentAdmin")).toBeLessThan(body.indexOf("upsert"));
  });

  it("me reports admins and the member lock", () => {
    const meDto = functionSource("meDto");
    expect(meDto).toContain("isDeploymentOwner: isDeploymentAdmin(actor)");
    expect(meDto).toContain("memberSettingsLocked: lockedForActor(");
  });

  it("a member's main model resolves on the shared owner's scope", () => {
    expect(functionSource("modelSetup")).toContain("sharedModelScope(deps.prisma, actor)");
  });

  it("ownerManaged asserts the member lock", () => {
    const context = sources.find((source) => source.includes("const ownerManaged = authed.use("));
    expect(context).toBeDefined();
    expect(context).toMatch(
      /const ownerManaged = authed\.use\(async \(\{ context, next \}\) => \{\s*await assertMemberSettingsUnlocked\(deps\.prisma, context\.actor\);\s*return next\(\);/,
    );
  });
});
