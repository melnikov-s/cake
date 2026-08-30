import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { fencedCode, Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { CakeRequestView } from "../../ipc/request-contract";
import {
  inlineWidgetMessageSchema,
  inlineWidgetRepairContext,
} from "../../utils/inline-widget-message";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { InlineWidgetRepairPrompt } from "./inline-widget-repair-prompt";

export const RequestWidget = observer(function RequestWidget({
  artifact,
  view,
  title,
  requested,
  fallback,
  onSubmit,
  onSkip,
  store,
  fullscreen,
  onCloseFullscreen,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "request" }>;
  view: Extract<CakeRequestView, { type: "widget" }>;
  title: string;
  requested: boolean;
  fallback: string;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
  store: InlineWidgetStore;
  fullscreen: boolean;
  onCloseFullscreen(): void;
}) {
  const id = `${artifact.sessionId}:request:${artifact.id}:${artifact.revision}`;
  const state = store.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const fullscreenIframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [repairPromptOpen, setRepairPromptOpen] = useState(false);
  useEffect(
    () => store.prepare(id, view.language, view.source, "request"),
    [id, store, view.language, view.source],
  );
  useEffect(() => {
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
      if (parsed.data.type === "error") store.reportRuntimeError(id, String(parsed.data.value));
      if (parsed.data.type === "submit") onSubmit?.(parsed.data.value);
      if (requested && parsed.data.type === "cancel") onSkip?.();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, onSkip, onSubmit, requested, state?.compiled, store]);
  const status = state?.status ?? "building";
  const submitRepair = (instructions: string) => {
    setRepairPromptOpen(false);
    void store.repair({
      id,
      sessionId: artifact.sessionId,
      context: inlineWidgetRepairContext(fallback, instructions),
    });
  };
  return (
    <section
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
      aria-label={`Custom ${view.language} request`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 font-mono text-[11px]">
        <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="text-foreground">
          {view.language === "react" ? "React request" : "HTML request"}
        </span>
        <span className="text-muted-foreground">
          {status === "repairing"
            ? "Repairing…"
            : status === "building"
              ? "Building…"
              : status === "error"
                ? "Needs attention"
                : requested
                  ? "Waiting for you"
                  : "Inactive"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline"
            onClick={() => setSourceOpen((open) => !open)}
          >
            {sourceOpen ? "Hide source" : "Source"}
          </button>
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline disabled:opacity-50"
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
        <div
          className="border-b border-border bg-destructive/10 p-2.5 text-xs text-destructive"
          role="alert"
        >
          <strong>Request widget could not render</strong>
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
          {fencedCode(state?.source ?? view.source, view.language === "react" ? "tsx" : "html")}
        </Markdown>
      )}
      {fullscreen && state?.compiled && (
        <FullscreenSurface
          mode="canvas"
          eyebrow={`${view.language === "react" ? "React" : "HTML"} request`}
          title={title}
          onClose={onCloseFullscreen}
        >
          <iframe
            ref={fullscreenIframe}
            title={`${title} fullscreen`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={state.compiled.url}
          />
        </FullscreenSurface>
      )}
    </section>
  );
});
