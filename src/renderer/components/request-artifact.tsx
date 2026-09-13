import { Option, Schema } from "effect";
import { Markdown } from "@/components/ai-elements/markdown";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";
import { cakeRequestV1Schema } from "../../ipc/request-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { ArtifactForm } from "./artifact-form";
import { RequestWidget } from "./request-widget";

export function RequestArtifact({
  artifact,
  requested,
  submittedAnswer,
  onSubmit,
  onSkip,
  inlineWidgets,
  fill = false,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "request" }>;
  requested: boolean;
  submittedAnswer?: JsonValue;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
  inlineWidgets?: InlineWidgetStore;
  fill?: boolean;
}) {
  const parsed = Schema.decodeUnknownOption(cakeRequestV1Schema)(artifact.payload.request);
  if (Option.isNone(parsed)) return <Markdown>{artifact.fallback.markdown}</Markdown>;
  const request = parsed.value;
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
  if (!inlineWidgets) return <Markdown>{request.fallback.markdown}</Markdown>;
  return (
    <RequestWidget
      artifact={artifact}
      view={request.view}
      requested={requested}
      fallback={request.fallback.markdown}
      onSubmit={onSubmit}
      onSkip={onSkip}
      store={inlineWidgets}
      fill={fill}
    />
  );
}
