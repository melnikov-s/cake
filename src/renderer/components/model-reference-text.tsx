import { splitModelReferences } from "../../contracts/model-presets/model-reference";
import { ModelReferenceChip } from "./ui/model-reference-chip";

/** Read-only projection of the exact text delivered to Pi. No configuration actions. */
export function ModelReferenceText({ text }: { text: string }) {
  return (
    <span className="whitespace-pre-wrap">
      {splitModelReferences(text).map((part) =>
        part.model ? <ModelReferenceChip key={part.start} model={part.model} /> : part.text,
      )}
    </span>
  );
}
