import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { UiPart } from "../../../ipc/session-contract";
import { isWorkLogPart } from "../../../utils/work-log-groups";
import { projectSessionEntries } from "./session-projection";
import {
  toolCompactEntryType,
  toolCompactProvenanceEntryType,
  toolCompactProvenanceSchema,
  type ToolCompactProvenance,
} from "./tool-compaction-provenance";

const maximumProvenanceDepth = 16;

type ProjectionResult =
  | { readonly valid: true; readonly parts: UiPart[] }
  | { readonly valid: false };

function projectedDialogueParts(entry: SessionEntry): UiPart[] {
  return projectSessionEntries([entry]).filter((part) => !isWorkLogPart(part));
}

function compactedPart(part: UiPart): UiPart {
  if (!isWorkLogPart(part)) return part;
  if (part.kind === "reasoning" || part.kind === "tool" || part.kind === "command")
    return { ...part, origin: "compacted" };
  return part;
}

function dialoguePartsCorrespond(source: readonly UiPart[], replayed: readonly UiPart[]) {
  return (
    source.length === replayed.length &&
    source.every((part, index) => part.kind === replayed[index]?.kind)
  );
}

function locateProvenance(branch: readonly SessionEntry[]) {
  const markerIndexes = branch.flatMap((entry, index) =>
    entry.type === "custom_message" && entry.customType === toolCompactEntryType ? [index] : [],
  );
  const candidates = branch.flatMap((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== toolCompactProvenanceEntryType) return [];
    const parsed = Schema.decodeUnknownOption(toolCompactProvenanceSchema)(entry.data);
    return Option.isSome(parsed) ? [{ entry, index, provenance: parsed.value }] : [];
  });
  if (markerIndexes.length === 0 || candidates.length === 0) return undefined;
  return candidates.at(-1);
}

function validateReplay(
  session: SessionManager,
  branch: readonly SessionEntry[],
  provenanceIndex: number,
  provenance: ToolCompactProvenance,
) {
  const markerIndex = branch.findIndex((entry) => entry.id === provenance.markerEntryId);
  const replayStartIndex = branch.findIndex((entry) => entry.id === provenance.replayStartEntryId);
  const replayEndIndex = branch.findIndex((entry) => entry.id === provenance.replayEndEntryId);
  if (
    markerIndex < 0 ||
    replayStartIndex !== markerIndex + 1 ||
    replayEndIndex < replayStartIndex ||
    replayEndIndex >= provenanceIndex
  )
    return undefined;

  const replayRange = branch.slice(replayStartIndex, replayEndIndex + 1);
  const sourceBranch = session.getBranch(provenance.sourceLeafId);
  const replayableSourceIds = sourceBranch.flatMap((entry) => {
    if (entry.type !== "message") return [];
    if (entry.message.role === "user") return [entry.id];
    if (
      entry.message.role === "assistant" &&
      entry.message.content.some((block) => block.type === "text" && Boolean(block.text.trim()))
    )
      return [entry.id];
    return [];
  });
  if (
    replayRange.length !== provenance.mappings.length ||
    replayableSourceIds.length !== provenance.mappings.length
  )
    return undefined;
  const sourceIds = new Set<string>();
  const replayedIds = new Set<string>();
  for (const [index, mapping] of provenance.mappings.entries()) {
    const source = session.getEntry(mapping.sourceEntryId);
    const replayed = session.getEntry(mapping.replayedEntryId);
    if (
      !source ||
      !replayed ||
      source.type !== "message" ||
      replayed.type !== "message" ||
      source.message.role !== replayed.message.role ||
      replayableSourceIds[index] !== mapping.sourceEntryId ||
      replayRange[index]?.id !== mapping.replayedEntryId ||
      sourceIds.has(mapping.sourceEntryId) ||
      replayedIds.has(mapping.replayedEntryId)
    )
      return undefined;
    sourceIds.add(mapping.sourceEntryId);
    replayedIds.add(mapping.replayedEntryId);
  }
  return { markerIndex };
}

function reconstruct(
  session: SessionManager,
  leafId: string | undefined,
  visitedLeaves: ReadonlySet<string>,
  depth: number,
  live: boolean,
): ProjectionResult {
  const branch = session.getBranch(leafId);
  const resolvedLeafId = branch.at(-1)?.id;
  if (!resolvedLeafId) return { valid: true, parts: [] };
  if (depth > maximumProvenanceDepth || visitedLeaves.has(resolvedLeafId)) return { valid: false };

  const located = locateProvenance(branch);
  if (!located) return { valid: true, parts: projectSessionEntries(branch, branch, { live }) };
  const replay = validateReplay(session, branch, located.index, located.provenance);
  if (!replay) return { valid: false };

  const source = reconstruct(
    session,
    located.provenance.sourceLeafId,
    new Set([...visitedLeaves, resolvedLeafId]),
    depth + 1,
    false,
  );
  if (!source.valid) return source;

  const replacements = new Map<string, UiPart>();
  for (const mapping of located.provenance.mappings) {
    const sourceEntry = session.getEntry(mapping.sourceEntryId)!;
    const replayedEntry = session.getEntry(mapping.replayedEntryId)!;
    const sourceDialogue = projectedDialogueParts(sourceEntry);
    const replayedDialogue = projectedDialogueParts(replayedEntry);
    if (!dialoguePartsCorrespond(sourceDialogue, replayedDialogue)) return { valid: false };
    sourceDialogue.forEach((part, index) => replacements.set(part.id, replayedDialogue[index]!));
  }

  const reconstructedPrefix = source.parts.map(
    (part) => replacements.get(part.id) ?? compactedPart(part),
  );
  const markerParts = projectSessionEntries(branch.slice(0, replay.markerIndex + 1));
  const postEntries = branch.slice(located.index + 1);
  const postCompactionParts = projectSessionEntries(postEntries, postEntries, { live });
  return {
    valid: true,
    parts: [...markerParts, ...reconstructedPrefix, ...postCompactionParts],
  };
}

/**
 * Projects the Conversation timeline while recovering work logs from provenance-linked
 * inactive Pi branches. Pi's active branch remains the sole model-context branch.
 */
export function projectConversationDisplay(
  session: SessionManager,
  options: { readonly live?: boolean } = {},
): UiPart[] {
  const activeBranch = session.getBranch();
  const result = reconstruct(session, undefined, new Set(), 0, options.live === true);
  return result.valid
    ? result.parts
    : projectSessionEntries(activeBranch, activeBranch, { live: options.live });
}
