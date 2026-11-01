import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DictationSnapshot } from "../../lib/dictation";
import { Dictation, webSpeechAvailable } from "../../lib/dictation";
import { IconTooltip } from "../IconTooltip";

/** A separate session from hold-to-talk: its only output is an editable draft. */
export function DictateButton({
  transcribe,
  disabled,
  onText,
}: {
  transcribe?: boolean;
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const { t } = useLingui();
  const [engine] = useState(() => new Dictation());
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(engine.state);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const available = webSpeechAvailable() || transcribe === true;

  useEffect(() => {
    const unsubscribe = engine.subscribe((next) => {
      if (!active.current) return;
      setSnapshot(next);
      if (next.status !== "idle") return;
      active.current = false;
      if (next.error) engine.stop("cancel");
      setNotice(
        next.error?.includes("not-allowed")
          ? t`Allow microphone and speech recognition access to dictate.`
          : (next.error ?? t`Nothing heard. Try again.`),
      );
    });
    return unsubscribe;
  }, [engine, t]);

  useEffect(
    () => () => {
      generation.current += 1;
      active.current = false;
      engine.stop("cancel");
    },
    [engine],
  );

  useEffect(() => {
    if (!disabled && available) return;
    generation.current += 1;
    active.current = false;
    engine.stop("cancel");
    setSnapshot(engine.state);
    setNotice(null);
  }, [disabled, available, engine]);

  if (!available) return null;
  const listening = snapshot.status === "listening";
  const transcribing = snapshot.status === "transcribing";
  const label = listening ? t`Stop dictation` : t`Dictate`;

  function toggle() {
    if (disabled || transcribing) return;
    if (active.current) {
      engine.submitHold();
      return;
    }
    const mine = ++generation.current;
    setNotice(null);
    active.current = true;
    void engine
      .listen({
        mode: "hold",
        // Unknown provider capabilities must not route mobile browsers to the server.
        transcribe: transcribe === true,
        onFinal: (text) => {
          if (mine !== generation.current) return;
          setNotice(null);
          onTextRef.current(text);
        },
      })
      .catch(() => {
        if (mine !== generation.current) return;
        active.current = false;
        engine.stop("cancel");
        setSnapshot(engine.state);
        setNotice(t`Dictation failed. Try again.`);
      });
  }

  return (
    <div className="relative flex shrink-0">
      <IconTooltip label={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={listening}
          disabled={disabled || transcribing}
          onClick={toggle}
          className="size-8 rounded-full text-muted-foreground"
        >
          {listening ? <Square size={14} /> : <Mic size={16} />}
        </Button>
      </IconTooltip>
      {notice || snapshot.status !== "idle" ? (
        <div
          role={notice ? "alert" : "status"}
          className="absolute bottom-full end-0 mb-2 w-64 rounded-lg border border-border bg-popover p-2 text-sm text-popover-foreground shadow-sm"
          dir="auto"
        >
          {notice ?? (transcribing ? t`Transcribing…` : snapshot.transcript || t`Listening…`)}
        </div>
      ) : null}
    </div>
  );
}
