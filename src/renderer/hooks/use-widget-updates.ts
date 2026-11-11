import { useEffect, type RefObject } from "react";
import { Option, Schema } from "effect";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

const requestEnvelope = Schema.Struct({
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
  type: Schema.Literal("widget-subscribe"),
  value: Schema.Struct({ id: Schema.String }),
});

/** All subscription resources belong to the frame, never to an author-supplied cleanup callback. */
export function useWidgetUpdates(
  iframe: RefObject<HTMLIFrameElement | null>,
  token: string | undefined,
  widgets: InlineWidgetStore | undefined,
  viewId: string,
) {
  useEffect(() => {
    if (!token || !widgets) return;
    const subscriptions = new Map<string, () => void>();
    const target = iframe.current?.contentWindow;
    const post = (type: string, value: JsonValue) =>
      target?.postMessage({ source: "cake-artifact-host", token, type, value }, "*");
    const receive = (event: MessageEvent) => {
      if (event.source !== target) return;
      const parsed = Schema.decodeUnknownOption(inlineWidgetMessageSchema)(event.data);
      if (Option.isNone(parsed)) {
        const envelope = Schema.decodeUnknownOption(requestEnvelope)(event.data);
        if (Option.isSome(envelope) && envelope.value.token === token)
          post("call-result", {
            id: envelope.value.value.id,
            ok: false,
            error:
              "Invalid widget subscription; use a supported event/filter or a poll interval between 1000 and 3600000 ms",
          });
        return;
      }
      const message = parsed.value;
      if (message.token !== token) return;
      if (message.type === "widget-unsubscribe") {
        subscriptions.get(message.value.subscriptionId)?.();
        subscriptions.delete(message.value.subscriptionId);
      }
      if (message.type !== "widget-subscribe") return;
      const request = message.value;
      try {
        subscriptions.get(request.subscriptionId)?.();
        const update = (value: JsonValue) =>
          post("widget-update", { id: request.subscriptionId, update: value });
        const failure = (error: unknown) =>
          update({ ok: false, error: error instanceof Error ? error.message : String(error) });
        const stop =
          request.kind === "poll"
            ? widgets.subscribeWidgetPoll(viewId, request.options, update, failure)
            : widgets.subscribeWidgetEvent(
                { topic: request.topic, filter: request.filter },
                update,
                failure,
              );
        subscriptions.set(request.subscriptionId, stop);
        post("call-result", { id: request.id, ok: true, result: { subscribed: true } });
      } catch (error) {
        post("call-result", {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      for (const stop of subscriptions.values()) stop();
    };
  }, [iframe, token, widgets, viewId]);
}
