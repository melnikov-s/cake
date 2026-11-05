import type { ModelReferenceSelection } from "../../../contracts/model-presets/model-reference";
import { modelReferenceLabel } from "../../../contracts/model-presets/model-reference";

export const modelReferenceChipClassName =
  "inline-flex max-w-64 align-baseline items-center truncate rounded-md border border-accent/30 bg-accent/10 px-1.5 text-xs font-medium leading-5 text-foreground";

/** A model mention, deliberately not a session configuration control. */
export function ModelReferenceChip({ model }: { model: ModelReferenceSelection }) {
  return (
    <span
      className={modelReferenceChipClassName}
      title={`${model.provider}/${model.modelId}`}
      data-slot="model-reference"
    >
      {modelReferenceLabel(model)}
    </span>
  );
}
