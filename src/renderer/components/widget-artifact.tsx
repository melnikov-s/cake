import { Option, Schema } from "effect";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { WidgetFailure } from "./widget-failure";
import { useWidgetUpdates } from "../hooks/use-widget-updates";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
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
import { useWidgetSpeech } from "../hooks/use-widget-speech";
import {
  decodeWidgetComposerAttachInput,
  widgetComposerInputError,
} from "../../contracts/widgets/widget-composer-item";

const detachedState = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactState));

export const WidgetArtifact = observer(function WidgetArtifact({
  artifact,
  inlineWidgets,
  stateSessionId,
  attachmentId,
  viewSession,
  onInteraction,
  fill = false,
  presentation = "workspace",
}: {
  artifact: Extract<CakeArtifactV1, { kind: "widget" }>;
  inlineWidgets?: InlineWidgetStore;
  stateSessionId?: string;
  attachmentId?: string;
  viewSession?: ArtifactNavigationContext["session"];
  onInteraction?(): void;
  fill?: boolean;
  presentation?: "inline" | "workspace";
}) {
  const instance = useId();
  const id = `${stateSessionId ?? "catalog"}:widget:${artifact.id}:${artifact.revision}:${instance}`;
  const browserDigest = artifact.payload.browser.digest;
  const state = inlineWidgets?.state(id);
  const liveState = inlineWidgets?.artifactStates[id];
  const navigation = inlineWidgets?.navigationContext;
  const postContext = useCallback(() => {
    if (!state?.compiled) return;
    iframe.current?.contentWindow?.postMessage(
      {
        source: "cake-artifact-host",
        token: state.compiled.token,
        type: "context",
        value: navigation
          ? {
              ...navigation,
              session: viewSession === undefined ? navigation.session : viewSession,
              viewId: id,
            }
          : { session: viewSession ?? null, viewId: id },
      },
      "*",
    );
  }, [id, navigation, state?.compiled, viewSession]);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [readyToken, setReadyToken] = useState<string>();
  const activeToken = state?.status === "error" ? undefined : state?.compiled?.token;
  useWidgetSpeech(iframe, activeToken, inlineWidgets?.speech);
  useWidgetUpdates(iframe, activeToken, inlineWidgets, id);
  useEffect(postContext, [postContext]);
  useEffect(() => {
    if (inlineWidgets) inlineWidgets.prepareBrowser(id, { digest: browserDigest });
    if (inlineWidgets)
      inlineWidgets.bindArtifactState(
        id,
        stateSessionId,
        decodeArtifactLineageId(artifact.id),
        attachmentId,
      );
    return () => {
      inlineWidgets?.release(id);
      inlineWidgets?.releaseArtifactState(id);
    };
  }, [artifact.id, attachmentId, browserDigest, id, inlineWidgets, stateSessionId]);
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
      if (parsed.value.type === "artifact-interaction") onInteraction?.();
      // DOMContentLoaded's state handshake also delivers the latest navigation snapshot.
      if (parsed.value.type === "artifact-state-read" || parsed.value.type === "ready")
        postContext();
      if (parsed.value.type === "ready") {
        inlineWidgets.browserViewReady(id, state.compiled.token);
        setReadyToken(state.compiled.token);
      }
      if (parsed.value.type === "height")
        setHeight(Math.max(120, Math.min(1_200, Math.ceil(parsed.value.value))));
      if (parsed.value.type === "error")
        inlineWidgets.reportRuntimeError(id, String(parsed.value.value));
      if (
        parsed.value.type === "artifact-tool-call" ||
        parsed.value.type === "artifact-cake-call"
      ) {
        const message = parsed.value;
        const token = state.compiled.token;
        const target = iframe.current?.contentWindow;
        const operation =
          message.type === "artifact-tool-call"
            ? inlineWidgets.callArtifactTool(id, message.value.name, message.value.input)
            : inlineWidgets.callArtifactCake(id, message.value.command, message.value.input);
        void operation.then(
          (result) =>
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token,
                type: "call-result",
                value: { id: message.value.id, ok: true, result },
              },
              "*",
            ),
          (error) =>
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token,
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
      }
      if (parsed.value.type === "composer-attach" || parsed.value.type === "composer-targets") {
        const message = parsed.value;
        const token = state.compiled.token;
        const target = iframe.current?.contentWindow;
        const session =
          viewSession === undefined ? (navigation?.session ?? null) : (viewSession ?? null);
        const request =
          message.type === "composer-attach"
            ? decodeWidgetComposerAttachInput(message.value.item)
            : undefined;
        // The rendering host owns the widget origin; the iframe supplies only the item.
        const operation = !request
          ? Promise.resolve(inlineWidgets.composerTargets(session))
          : request._tag === "Failure"
            ? Promise.resolve({ ok: false, error: widgetComposerInputError(request.failure) })
            : inlineWidgets.attachToComposer(
                {
                  lineageId: decodeArtifactLineageId(artifact.id),
                  revision: artifact.revision,
                  ...(artifact.title ? { title: artifact.title.slice(0, 512) } : null),
                },
                request.success,
                session,
              );
        void operation.then(
          (result) =>
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token,
                type: "call-result",
                value: { id: message.value.id, ok: true, result },
              },
              "*",
            ),
          (error) =>
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token,
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
      }
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
  }, [
    artifact.id,
    artifact.revision,
    artifact.title,
    id,
    inlineWidgets,
    navigation?.session,
    state?.compiled,
    onInteraction,
    postContext,
    viewSession,
  ]);

  if (!inlineWidgets) return <Markdown>{artifact.fallback.markdown}</Markdown>;
  if (state?.status === "error")
    return (
      <div>
        <WidgetFailure
          diagnostic={state.diagnostic ?? "Widget view unavailable"}
          retry={() => inlineWidgets.retryBrowserView(id)}
          repair={
            inlineWidgets.canRepair
              ? () => inlineWidgets.repair(artifact, state.diagnostic ?? "Widget view unavailable")
              : undefined
          }
        />
        <Markdown>{artifact.fallback.markdown}</Markdown>
      </div>
    );
  if (!state?.compiled) return <div className="min-h-55" aria-busy="true" />;
  return (
    <div
      className={fill ? "flex h-full min-h-0 flex-col" : "flex flex-col"}
      data-widget-view-id={id}
      data-widget-view-ready={readyToken === state.compiled.token}
    >
      <InlineWidgetFrame
        ref={iframe}
        className={fill ? "min-h-0 flex-1" : undefined}
        title={artifact.title ?? artifact.id}
        compiled={state.compiled}
        downloads
        presentation={presentation}
        style={fill ? undefined : { height }}
      />
    </div>
  );
});
