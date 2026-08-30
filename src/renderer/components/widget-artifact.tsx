import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { fencedCode, Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
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
      <Callout variant="error">
        <strong>Widget unavailable</strong>
        <span className="text-xs">Cake could not access its widget compiler.</span>
      </Callout>
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
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
      aria-label={`Delegated ${artifact.payload.language} widget`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 font-mono text-[11px]">
        <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="text-foreground">
          Delegated {artifact.payload.language === "react" ? "React" : "HTML"} widget
        </span>
        <span className="text-muted-foreground">
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
        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="h-auto p-0 text-[11px] text-accent hover:underline hover:bg-transparent"
            onClick={() => setSourceOpen((open) => !open)}
          >
            {sourceOpen ? "Hide source" : "Source"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="h-auto p-0 text-[11px] text-accent hover:underline hover:bg-transparent"
            disabled={status === "repairing" || status === "building"}
            onClick={() => setRepairPromptOpen((open) => !open)}
          >
            {repairPromptOpen ? "Close" : "Repair"}
          </Button>
        </span>
      </div>
      {repairPromptOpen && (
        <InlineWidgetRepairPrompt
          onCancel={() => setRepairPromptOpen(false)}
          onSubmit={submitRepair}
        />
      )}
      {status === "error" && (
        <div
          className="border-b border-border bg-destructive/10 p-2.5 text-xs text-destructive"
          role="alert"
        >
          <strong>Widget could not render</strong>
          <pre className="mt-1 font-mono">{state?.diagnostic}</pre>
        </div>
      )}
      {state?.compiled && (
        <iframe
          ref={iframe}
          title={artifact.title ?? artifact.id}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={state.compiled.url}
          className="w-full border-none"
          style={{ height }}
        />
      )}
      {sourceOpen && (
        <Markdown className="max-h-80 overflow-auto border-t border-border p-2">
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
