// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./composer";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("SpeechRecognition", class {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([
  { phoneCallsEnabled: false, busy: false, dictationTranscribe: undefined },
  { phoneCallsEnabled: true, busy: false, dictationTranscribe: undefined },
  { phoneCallsEnabled: true, busy: true, dictationTranscribe: undefined },
  { phoneCallsEnabled: false, busy: false, dictationTranscribe: true },
])("keeps the draft, Send, and Dictate in tab order: %j", (options) => {
  if (options.dictationTranscribe) vi.stubGlobal("SpeechRecognition", undefined);
  const props: ComponentProps<typeof Composer> = {
    artifactTarget: { botId: "bot-1" },
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    onOpenModels: vi.fn(),
    onOpenConnections: vi.fn(),
    runError: null,
    runErrorId: null,
    onRunErrorPresented: vi.fn(),
    onDismissError: vi.fn(),
    sending: false,
    fileInputRef: createRef(),
    onAttachmentPick: () => true,
    onRemoveAttachment: vi.fn(),
    onSend: vi.fn(async () => true),
    draftKey: "bot:tab-order",
    enterToSend: true,
    ...options,
  };
  act(() => root.render(<Composer {...props} />));
  const textarea = container.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(textarea, "Review the report");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  const dictate = container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!;
  expect(send.disabled).toBe(false);
  expect(dictate.disabled).toBe(false);
  expect(dictate.tabIndex).toBe(0);
  expect(dictate.closest("[hidden], [inert]")).toBeNull();
  // Native Tab traversal follows DOM order for these controls, all with tabIndex 0.
  const tabStops = Array.from(
    container.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>("textarea, button"),
  ).filter((element) => !element.disabled && element.tabIndex >= 0);
  expect(tabStops.slice(tabStops.indexOf(textarea))).toEqual([textarea, send, dictate]);
});
