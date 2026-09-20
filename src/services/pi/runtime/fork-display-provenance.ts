import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import { uiPartSchema, type UiPart } from "../../../ipc/session-contract";
import { isCompactedWorkLogPart } from "../../../utils/work-log-groups";

/** Hidden display-only provenance carried by an ordinary Pi fork. */
export const forkDisplayProvenanceEntryType = "cake.fork-display-provenance/v1";

const partIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

const forkDisplayGroupSchema = Schema.Struct({
  precedingPartId: Schema.NullOr(partIdSchema),
  parts: Schema.Array(uiPartSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50_000)),
});

const forkDisplayProvenanceSchema = Schema.Struct({
  version: Schema.Literal(1),
  groups: Schema.Array(forkDisplayGroupSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50_000),
  ),
});

export interface ForkDisplayProvenance extends Schema.Schema.Type<
  typeof forkDisplayProvenanceSchema
> {}

/**
 * Captures only reconstructed historical work that Pi's branch extraction cannot
 * reach. The record is appended as a hidden Pi custom entry and never enters
 * model context.
 */
export function captureForkDisplayProvenance(
  parts: readonly UiPart[],
): ForkDisplayProvenance | undefined {
  const groups: Array<{
    precedingPartId: string | null;
    parts: UiPart[];
  }> = [];
  let precedingPartId: string | null = null;

  for (const part of parts) {
    if (!isCompactedWorkLogPart(part)) {
      precedingPartId = part.id;
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.precedingPartId === precedingPartId) previous.parts.push(part);
    else groups.push({ precedingPartId, parts: [part] });
  }

  return groups.length > 0 ? { version: 1, groups } : undefined;
}

export function appendForkDisplayProvenance(
  session: SessionManager,
  provenance: ForkDisplayProvenance | undefined,
) {
  if (provenance) session.appendCustomEntry(forkDisplayProvenanceEntryType, provenance);
}

export function decodeForkDisplayProvenance(data: unknown) {
  return Schema.decodeUnknownOption(forkDisplayProvenanceSchema)(data).pipe(
    Option.filter((provenance) => {
      const partIds = new Set<string>();
      let partCount = 0;
      return provenance.groups.every((group) =>
        group.parts.every((part) => {
          partCount += 1;
          if (partCount > 50_000 || !isCompactedWorkLogPart(part) || partIds.has(part.id))
            return false;
          partIds.add(part.id);
          return true;
        }),
      );
    }),
  );
}
