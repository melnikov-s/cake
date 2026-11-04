import { Option, Schema } from "effect";
import { useEffect, useId, type RefObject } from "react";
import { inlineWidgetSpeechMessageSchema } from "../../utils/inline-widget-message";
import type { WidgetSpeech, WidgetSpeechState } from "../speech/widget-speech";

const decodeSpeechMessage = Schema.decodeUnknownOption(inlineWidgetSpeechMessageSchema);

/** Connects one widget frame's `cakeSpeech` bridge to the shared reader; unmount stops it. */
export function useWidgetSpeech(
  frame: RefObject<HTMLIFrameElement | null>,
  token: string | undefined,
  speech: WidgetSpeech | undefined,
) {
  const owner = useId();
  useEffect(() => {
    if (!token || !speech) return;
    const post = (state: WidgetSpeechState) =>
      frame.current?.contentWindow?.postMessage(
        { source: "cake-widget-host", token, type: "speech-state", value: state },
        "*",
      );
    const receive = (event: MessageEvent) => {
      if (!event.source || event.source !== frame.current?.contentWindow) return;
      const parsed = decodeSpeechMessage(event.data);
      if (Option.isNone(parsed) || parsed.value.token !== token) return;
      const request = parsed.value.value;
      if (request.action === "speak") speech.speak(owner, request, post);
      else speech[request.action](owner);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      speech.release(owner);
    };
  }, [frame, owner, speech, token]);
}
