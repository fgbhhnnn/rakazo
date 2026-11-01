import { describe, expect, it, vi } from "vitest";
import { redactConnectorPayload } from "./connector-safety.js";
import { redactPiContent, withPiContentRedaction } from "./pi-content-redaction.js";
import {
  recordPiTelemetryContent,
  shutdownPiTelemetry,
  withPiTelemetry,
  withPiTelemetrySpan,
} from "./pi-telemetry.js";

const telemetry = vi.hoisted(() => ({ setAttributes: vi.fn() }));
vi.mock("./pi-telemetry-otel.js", () => {
  const span = {
    setAttributes: telemetry.setAttributes,
    startSpan: (_options: unknown, work: (span: unknown) => unknown): unknown => work(span),
  };
  return { createPiTelemetryExporter: async () => ({ context: span, shutdown: async () => {} }) };
});

describe("optional telemetry redaction", () => {
  it("scrubs tool results and subsequent prompts using the run's live secret list", async () => {
    vi.stubEnv("OTEL_CAPTURE_CONTENT", "true");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example.test:4318");
    try {
      const values: string[] = [];
      const setAttributes = telemetry.setAttributes.mockClear();
      await withPiTelemetry(
        {
          botId: "bot",
          runId: "run",
          redactTelemetryContent: (v) => redactConnectorPayload(v, values),
        },
        () =>
          withPiTelemetrySpan("pi.agent.tool", {}, async (span) => {
            values.push("fake-password");
            for (const key of [
              "pi.agent.tool.result",
              "pi.ai.prompt",
              "pi.ai.response",
              "pi.agent.tool.arguments",
            ]) {
              recordPiTelemetryContent(span, key, { value: "fake-password" });
            }
          }),
      );
      expect(setAttributes).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(setAttributes.mock.calls)).not.toContain("fake-password");
      expect(JSON.stringify(setAttributes.mock.calls)).toContain("[redacted]");
    } finally {
      await shutdownPiTelemetry();
      vi.unstubAllEnvs();
    }
  });
  it("isolates simultaneous runs and restores the enclosing context", async () => {
    const results = await Promise.all(
      ["one", "two"].map((value) =>
        withPiContentRedaction(
          () => value,
          async () => {
            await Promise.resolve();
            return redactPiContent("input");
          },
        ),
      ),
    );
    expect(results).toEqual(["one", "two"]);
    expect(redactPiContent("input")).toBe("input");
  });
});
