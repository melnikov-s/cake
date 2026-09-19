import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { SessionPlugin } from "../../domain/application/application-data";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { InlineWidgetFrame } from "./inline-widget-frame";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";

export const SessionPluginContribution = observer(function SessionPluginContribution({
  plugin,
  sharedState,
  inlineWidgets,
  call,
}: {
  readonly plugin: SessionPlugin;
  readonly sharedState: Readonly<Record<string, JsonValue>>;
  readonly inlineWidgets: InlineWidgetStore;
  readonly call: (command: string, input: JsonObject) => Promise<JsonValue>;
}) {
  const compileId = `${plugin.sessionId}:session-plugin:${plugin.id}`;
  const compiledState = inlineWidgets.state(compileId);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(72);

  useEffect(() => {
    inlineWidgets.prepare(compileId, "react", plugin.source, "session-plugin");
  }, [compileId, inlineWidgets, plugin.source]);

  useEffect(() => {
    const frame = iframe.current?.contentWindow;
    const compiled = compiledState?.compiled;
    if (!frame || !compiled) return;
    frame.postMessage(
      {
        source: "cake-session-plugin-host",
        token: compiled.token,
        type: "context",
        value: { pluginState: plugin.state, sharedState },
      },
      "*",
    );
  }, [compiledState?.compiled, plugin.state, sharedState]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const parsed = Schema.decodeUnknownOption(inlineWidgetMessageSchema)(event.data);
      if (
        event.source !== iframe.current?.contentWindow ||
        !compiledState?.compiled ||
        Option.isNone(parsed) ||
        parsed.value.token !== compiledState.compiled.token
      )
        return;
      const message = parsed.value;
      if (message.type === "height") {
        setHeight(Math.max(48, Math.min(600, Math.ceil(message.value))));
        return;
      }
      if (message.type === "error") {
        inlineWidgets.reportRuntimeError(compileId, String(message.value));
        return;
      }
      if (message.type === "ready") {
        iframe.current?.contentWindow?.postMessage(
          {
            source: "cake-session-plugin-host",
            token: compiledState.compiled.token,
            type: "context",
            value: { pluginState: plugin.state, sharedState },
          },
          "*",
        );
        return;
      }
      if (message.type !== "plugin-call") return;
      void call(message.value.command, message.value.input).then(
        (result) =>
          iframe.current?.contentWindow?.postMessage(
            {
              source: "cake-session-plugin-host",
              token: compiledState.compiled?.token,
              type: "call-result",
              value: { id: message.value.id, ok: true, result },
            },
            "*",
          ),
        (error: unknown) =>
          iframe.current?.contentWindow?.postMessage(
            {
              source: "cake-session-plugin-host",
              token: compiledState.compiled?.token,
              type: "call-result",
              value: {
                id: message.value.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
            },
            "*",
          ),
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [call, compileId, compiledState?.compiled, inlineWidgets, plugin.state, sharedState]);

  if (compiledState?.status === "error")
    return (
      <Callout variant="error" title={`${plugin.title} failed to load`}>
        {compiledState.diagnostic}
      </Callout>
    );
  if (!compiledState?.compiled) return <LoadingState label={`Loading ${plugin.title}`} />;
  return (
    <InlineWidgetFrame
      ref={iframe}
      title={plugin.title}
      src={compiledState.compiled.url}
      style={{ height }}
    />
  );
});
