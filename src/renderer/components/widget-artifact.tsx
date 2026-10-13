import { Option, Schema } from "effect";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { observer } from "r-state-tree/react";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import {
  artifactStateRequestEnvelope,
  inlineWidgetMessageSchema,
} from "../../utils/inline-widget-message";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { InlineWidgetFrame } from "./inline-widget-frame";
import { decodeArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { ArtifactState } from "../../contracts/artifacts/artifact-state";
import { artifactStateWireError } from "../../contracts/widgets/artifact-state-wire";

const detachedState = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactState));

export const WidgetArtifact = observer(function WidgetArtifact({
  artifact,
  inlineWidgets,
  stateSessionId,
  fill = false,
  presentation = "workspace",
}: {
  artifact: Extract<CakeArtifactV1, { kind: "widget" }>;
  inlineWidgets?: InlineWidgetStore;
  stateSessionId?: string;
  fill?: boolean;
  presentation?: "inline" | "workspace";
}) {
  const instance = useId();
  const id = `${stateSessionId ?? "catalog"}:widget:${artifact.id}:${artifact.revision}:${instance}`;
  const state = inlineWidgets?.state(id);
  const liveState = inlineWidgets?.artifactStates[id];
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  useEffect(() => {
    if (inlineWidgets) inlineWidgets.prepareBrowser(id, artifact.payload.browser);
    if (inlineWidgets && stateSessionId)
      inlineWidgets.bindArtifactState(id, stateSessionId, decodeArtifactLineageId(artifact.id));
    return () => inlineWidgets?.releaseArtifactState(id);
  }, [artifact.id, artifact.payload.browser, id, inlineWidgets, stateSessionId]);
  useEffect(() => {
    if (!state?.compiled) return;
    if (liveState?.error)
      iframe.current?.contentWindow?.postMessage(
        {
          source: "cake-artifact-host",
          token: state.compiled.token,
          type: "state-error",
          value: liveState.error,
        },
        "*",
      );
    else if (liveState?.current)
      iframe.current?.contentWindow?.postMessage(
        {
          source: "cake-artifact-host",
          token: state.compiled.token,
          type: "state",
          value: detachedState(JSON.stringify(liveState.current)),
        },
        "*",
      );
  }, [state?.compiled, liveState?.current, liveState?.error]);
  useLayoutEffect(() => {
    if (!inlineWidgets) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || !state?.compiled) return;
      const envelope = Schema.decodeUnknownOption(artifactStateRequestEnvelope)(event.data);
      const parsed = Schema.decodeUnknownOption(inlineWidgetMessageSchema)(event.data);
      const wireError =
        Option.isSome(envelope) && envelope.value.type === "artifact-state-replace"
          ? artifactStateWireError(envelope.value.value.value)
          : undefined;
      if (
        (Option.isNone(parsed) || wireError) &&
        Option.isSome(envelope) &&
        envelope.value.token === state.compiled.token
      ) {
        iframe.current?.contentWindow?.postMessage(
          {
            source: "cake-artifact-host",
            token: state.compiled.token,
            type: "state-result",
            value: {
              id: envelope.value.value.id,
              ok: false,
              error: wireError
                ? `Invalid artifact state: ${wireError}`
                : "Invalid artifact state request: value must be JSON and expectedVersion a nonnegative integer",
            },
          },
          "*",
        );
        return;
      }
      if (Option.isNone(parsed) || parsed.value.token !== state.compiled.token) return;
      if (parsed.value.type === "height")
        setHeight(Math.max(120, Math.min(1_200, Math.ceil(parsed.value.value))));
      if (parsed.value.type === "error")
        inlineWidgets.reportRuntimeError(id, String(parsed.value.value));
      if (
        parsed.value.type === "artifact-state-read" ||
        parsed.value.type === "artifact-state-replace"
      ) {
        const message = parsed.value;
        const token = state.compiled.token;
        const target = iframe.current?.contentWindow;
        const operation =
          message.type === "artifact-state-read"
            ? inlineWidgets.readArtifactState(id)
            : inlineWidgets.saveArtifactState(
                id,
                message.value.value,
                message.value.expectedVersion,
              );
        void operation.then(
          (next) =>
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token,
                type: "state-result",
                value: { id: message.value.id, ok: true, state: next },
              },
              "*",
            ),
          (error) =>
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token,
                type: "state-result",
                value: {
                  id: message.value.id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              },
              "*",
            ),
        );
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, inlineWidgets, state?.compiled]);

  if (!inlineWidgets || state?.status === "error")
    return <Markdown>{artifact.fallback.markdown}</Markdown>;
  if (!state?.compiled) return <div className="min-h-55" aria-busy="true" />;
  return (
    <InlineWidgetFrame
      ref={iframe}
      className={fill ? "h-full" : undefined}
      title={artifact.title ?? artifact.id}
      compiled={state.compiled}
      downloads
      presentation={presentation}
      style={fill ? undefined : { height }}
    />
  );
});
