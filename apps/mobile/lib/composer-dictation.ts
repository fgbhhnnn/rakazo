import { recognitionLocaleTag } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import * as dictation from "./dictation";
import { deviceLanguage, useI18n } from "./i18n";

/** Owns only its abort signal, so leaving a composer cannot stop a newer call. */
export function useComposerDictation(onText: (text: string) => void, disabled = false) {
  const { locale, t } = useI18n();
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const session = useRef<AbortController | null>(null);
  const heard = useRef("");
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    let mounted = true;
    void dictation.available().then((value) => {
      if (mounted) setAvailable(value);
    });
    return () => {
      mounted = false;
      session.current?.abort();
      session.current = null;
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    session.current?.abort();
    session.current = null;
    setListening(false);
    setTranscript("");
    setNotice(null);
  }, [disabled]);

  function finish(controller: AbortController, text: string, failed = false) {
    if (session.current !== controller || controller.signal.aborted) return;
    session.current = null;
    controller.abort();
    setListening(false);
    setTranscript("");
    if (text.trim()) onTextRef.current(text.trim());
    else
      setNotice(
        failed
          ? t("Could not dictate. Check microphone and speech recognition permissions.")
          : t("Nothing heard. Try again."),
      );
  }

  async function toggle() {
    if (disabled || !available) return;
    if (session.current) {
      finish(session.current, heard.current);
      return;
    }
    const controller = new AbortController();
    session.current = controller;
    heard.current = "";
    setNotice(null);
    setTranscript("");
    setListening(true);
    try {
      const lang = recognitionLocaleTag(locale, await deviceLanguage());
      if (controller.signal.aborted) return;
      await dictation.listen({
        lang,
        signal: controller.signal,
        onInterim: (text) => {
          if (session.current !== controller || controller.signal.aborted) return;
          heard.current = text;
          setTranscript(text);
        },
        onFinal: (text) => finish(controller, text),
        onGiveUp: (reason) => finish(controller, "", reason === "failed"),
      });
    } catch {
      finish(controller, heard.current, true);
    }
  }

  return { available, listening, transcript, notice, toggle };
}
