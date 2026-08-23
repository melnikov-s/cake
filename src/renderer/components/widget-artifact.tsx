import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { fencedCode, Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import {
  inlineWidgetMessageSchema,
  inlineWidgetRepairContext,
} from "../../utils/inline-widget-message";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { InlineWidgetRepairPrompt } from "./inline-widget-repair-prompt";

export const WidgetArtifact = observer(function WidgetArtifact({
  artifact,
  inlineWidgets,
  fullscreen,
  onCloseFullscreen,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "widget" }>;
  inlineWidgets?: InlineWidgetStore;
  fullscreen: boolean;
  onCloseFullscreen(): void;
}) {
  const id = `${artifact.sessionId}:widget:${artifact.id}:${artifact.revision}`;
  const state = inlineWidgets?.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const fullscreenIframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [repairPromptOpen, setRepairPromptOpen] = useState(false);
  useEffect(() => {
    if (inlineWidgets)
      inlineWidgets.prepare(id, artifact.payload.language, artifact.payload.source);
  }, [artifact.payload.language, artifact.payload.source, id, inlineWidgets]);
  useEffect(() => {
    if (!inlineWidgets) return;
    const receive = (event: MessageEvent) => {
      const parsed = inlineWidgetMessageSchema.safeParse(event.data);
      if (
        (event.source !== iframe.current?.contentWindow &&
          event.source !== fullscreenIframe.current?.contentWindow) ||
        !state?.compiled ||
        !parsed.success ||
        parsed.data.token !== state.compiled.token
      )
        return;
      if (parsed.data.type === "height")
        setHeight(Math.max(120, Math.min(1_200, Math.ceil(parsed.data.value))));
      if (parsed.data.type === "error")
        inlineWidgets.reportRuntimeError(id, String(parsed.data.value));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, inlineWidgets, state?.compiled]);
  if (!inlineWidgets)
    return (
      <div className="notice notice-error">
        <strong>Widget unavailable</strong>
        <span>Cake could not access its widget compiler.</span>
      </div>
    );
  const status = state?.status ?? "building";
  const submitRepair = (instructions: string) => {
    setRepairPromptOpen(false);
    void inlineWidgets.repair({
      id,
      sessionId: artifact.sessionId,
      context: inlineWidgetRepairContext(artifact.payload.brief, instructions),
    });
  };
  return (
    <section
      className={`inline-widget inline-widget-${status}`}
      aria-label={`Delegated ${artifact.payload.language} widget`}
    >
      <div className="inline-widget-rail">
        <span className="inline-widget-notch" aria-hidden="true" />
        <span>Delegated {artifact.payload.language === "react" ? "React" : "HTML"} widget</span>
        <span className="inline-widget-status">
          {status === "repairing"
            ? "Repairing…"
            : status === "building"
              ? "Building…"
              : status === "error"
                ? "Needs attention"
                : state?.repairSessionId
                  ? "Repaired"
                  : "Ready"}
        </span>
        <span className="inline-widget-actions">
          <button type="button" onClick={() => setSourceOpen((open) => !open)}>
            {sourceOpen ? "Hide source" : "Source"}
          </button>
          <button
            type="button"
            disabled={status === "repairing" || status === "building"}
            onClick={() => setRepairPromptOpen((open) => !open)}
          >
            {repairPromptOpen ? "Close" : "Repair"}
          </button>
        </span>
      </div>
      {repairPromptOpen && (
        <InlineWidgetRepairPrompt
          onCancel={() => setRepairPromptOpen(false)}
          onSubmit={submitRepair}
        />
      )}
      {status === "error" && (
        <div className="inline-widget-diagnostic" role="alert">
          <strong>Widget could not render</strong>
          <pre>{state?.diagnostic}</pre>
        </div>
      )}
      {state?.compiled && (
        <iframe
          ref={iframe}
          title={artifact.title ?? artifact.id}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={state.compiled.url}
          style={{ height }}
        />
      )}
      {sourceOpen && (
        <Markdown className="inline-widget-source">
          {fencedCode(
            state?.source ?? artifact.payload.source,
            artifact.payload.language === "react" ? "tsx" : "html",
          )}
        </Markdown>
      )}
      {fullscreen && state?.compiled && (
        <FullscreenSurface
          mode="canvas"
          eyebrow={`${artifact.payload.language === "react" ? "React" : "HTML"} widget`}
          title={artifact.title ?? "Widget"}
          onClose={onCloseFullscreen}
        >
          <iframe
            ref={fullscreenIframe}
            title={`${artifact.title ?? artifact.id} fullscreen`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={state.compiled.url}
          />
        </FullscreenSurface>
      )}
    </section>
  );
});
