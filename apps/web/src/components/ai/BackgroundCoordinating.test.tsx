import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }) };
});

import { BackgroundCoordinatingRow } from "./BackgroundCoordinating";

const bot = { botId: "bot-1", color: "#14B8A6", name: "Main" };
const render = (tasks?: { running: number; queued: number }) =>
  renderToString(<BackgroundCoordinatingRow tasks={tasks} bot={bot} />);

describe("background coordinating row", () => {
  it("shows the bot's avatar and a neutral line without a count", () => {
    const html = render({ running: 2, queued: 3 });
    expect(html).toContain('data-testid="background-coordinating"');
    expect(html).toContain('role="status"');
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).toContain("Coordinating background tasks");
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("Coordinating background tasks");
  });

  it("shows for queued-only work and hides when idle", () => {
    expect(render({ running: 0, queued: 1 })).toContain("Coordinating background tasks");
    expect(render({ running: 0, queued: 0 })).toBe("");
    expect(render(undefined)).toBe("");
  });
});
