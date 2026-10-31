// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import { i18n } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recognitionLanguage } from "../../lib/dictation";
import { DictateButton } from "./DictateButton";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }) };
});
vi.mock("../IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
const locale = vi.hoisted(() => ({ current: "en" }));
vi.mock("../../lib/i18n", () => ({ getActiveUiLocale: () => locale.current }));

class Recognition {
  static current: Recognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    Recognition.current = this;
  }
  hear(text: string) {
    this.onresult?.({ resultIndex: 0, results: [[{ transcript: text }]] });
  }
}

describe("composer dictation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onText = vi.fn();
  const onSend = vi.fn();
  function Harness(props: Partial<ComponentProps<typeof DictateButton>>) {
    const [draft, setDraft] = useState("Draft");
    return (
      <form onSubmit={onSend}>
        <textarea value={draft} readOnly />
        <DictateButton
          onText={(text) => {
            onText(text);
            setDraft((current) => `${current} ${text}`);
          }}
          {...props}
        />
      </form>
    );
  }
  function render(props: Partial<ComponentProps<typeof DictateButton>> = {}) {
    act(() => root.render(<Harness {...props} />));
  }
  async function click(label: string) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    });
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("SpeechRecognition", Recognition);
    i18n.load("en", {});
    i18n.activate("en");
    locale.current = "en";
    onText.mockClear();
    onSend.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("previews interim words and appends only on stop, without submitting the form", async () => {
    render();
    await click("Dictate");
    act(() => Recognition.current.hear("你好世界"));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("你好世界");
    expect(container.querySelector("textarea")?.value).toBe("Draft");
    await click("Stop dictation");
    expect(container.querySelector("textarea")?.value).toBe("Draft 你好世界");
    expect(onText).toHaveBeenCalledExactlyOnceWith("你好世界");
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("appends when recognition ends on its own", async () => {
    render();
    await click("Dictate");
    act(() => {
      Recognition.current.hear("final words");
      Recognition.current.onend?.();
    });
    expect(onText).toHaveBeenCalledExactlyOnceWith("final words");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("uses zh-CN for Chinese UI even when the browser speaks English", async () => {
    locale.current = "zh-CN";
    expect(recognitionLanguage()).toBe("zh-CN");
    render();
    await click("Dictate");
    expect(Recognition.current.lang).toBe("zh-CN");
  });

  it("hides without either capability and shows for server transcription alone", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    render({ transcribe: false });
    expect(container.querySelector("button")).toBeNull();
    render({ transcribe: true });
    expect(container.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  });

  it("reports silence and clears the notice on retry", async () => {
    render();
    await click("Dictate");
    await click("Stop dictation");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Nothing heard. Try again.",
    );
    await click("Dictate");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onText).not.toHaveBeenCalled();
  });

  it("explains permission refusal", async () => {
    render();
    await click("Dictate");
    act(() => Recognition.current.onerror?.({ error: "not-allowed" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Allow microphone and speech recognition access to dictate.",
    );
    expect(onText).not.toHaveBeenCalled();
  });

  it("retains provider guidance when transcription cannot be used", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    const media = vi.fn().mockRejectedValue(new Error("Add a voice provider in Voice settings."));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: media } });
    render({ transcribe: true });
    await click("Dictate");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Add a voice provider",
    );
    expect(onText).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses server transcription when Web Speech is absent (success=%s)",
    async (success) => {
      locale.current = "zh-CN";
      vi.stubGlobal("SpeechRecognition", undefined);
      vi.stubGlobal("Blob", NodeBlob);
      const track = { stop: vi.fn() };
      vi.stubGlobal("navigator", {
        language: "en-US",
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
      });
      vi.stubGlobal(
        "MediaRecorder",
        class {
          state = "inactive";
          ondataavailable: ((event: { data: Blob }) => void) | null = null;
          onstop: (() => void) | null = null;
          start() {
            this.state = "recording";
          }
          stop() {
            this.state = "inactive";
            this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
            this.onstop?.();
          }
        },
      );
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json(
          success ? { text: "你好世界" } : { error: "Add a voice provider in Voice settings." },
          { status: success ? 200 : 400 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      render({ transcribe: true });
      await click("Dictate");
      await click("Stop dictation");
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "/api/voice/transcribe",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: expect.any(String),
        }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).language).toBe("zh");
      expect(track.stop).toHaveBeenCalled();
      if (success) {
        expect(onText).toHaveBeenCalledExactlyOnceWith("你好世界");
        expect(container.querySelector("textarea")?.value).toBe("Draft 你好世界");
      } else {
        expect(onText).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "Add a voice provider",
        );
      }
      expect(onSend).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "unmount"])("cancels and ignores late results on %s", async (reason) => {
    render();
    await click("Dictate");
    const recognition = Recognition.current;
    const lateResult = recognition.onresult;
    act(() => recognition.hear("discard"));
    if (reason === "disabled") render({ disabled: true });
    else act(() => root.render(null));
    act(() => lateResult?.({ resultIndex: 0, results: [[{ transcript: "late" }]] }));
    expect(recognition.abort).toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });
});
