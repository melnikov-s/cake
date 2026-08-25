import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";
import { cakeRequestV1Schema } from "../../ipc/request-contract";
import { ArtifactForm } from "./artifact-form";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { RequestWidget } from "./request-widget";

export function RequestArtifact({
  artifact,
  requested,
  submittedAnswer,
  onSubmit,
  onSkip,
  inlineWidgets,
  fullscreen,
  onCloseFullscreen,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "request" }>;
  requested: boolean;
  submittedAnswer?: JsonValue;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
  inlineWidgets?: InlineWidgetStore;
  fullscreen: boolean;
  onCloseFullscreen(): void;
}) {
  const parsed = cakeRequestV1Schema.safeParse(artifact.payload.request);
  if (!parsed.success)
    return (
      <div className="notice notice-error">
        <strong>Request could not render</strong>
        <span>{parsed.error.message}</span>
      </div>
    );
  const request = parsed.data;
  if (request.view.type === "form")
    return (
      <ArtifactForm
        fields={request.view.fields}
        requested={requested}
        submittedAnswer={submittedAnswer}
        onSubmit={onSubmit}
        onSkip={onSkip}
      />
    );
  if (!inlineWidgets)
    return (
      <div className="notice notice-error">
        <strong>Request widget unavailable</strong>
        <span>Cake could not access its widget compiler.</span>
      </div>
    );
  return (
    <RequestWidget
      artifact={artifact}
      view={request.view}
      title={request.title}
      requested={requested}
      fallback={request.fallback.markdown}
      onSubmit={onSubmit}
      onSkip={onSkip}
      store={inlineWidgets}
      fullscreen={fullscreen}
      onCloseFullscreen={onCloseFullscreen}
    />
  );
}
