import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { UiPart } from "../../../ipc/session-contract";
import { isWorkLogPart } from "../../../utils/work-log-groups";
import {
  decodeForkDisplayProvenance,
  forkDisplayProvenanceEntryType,
} from "./fork-display-provenance";
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

function applyForkDisplayProvenance(
  branch: readonly SessionEntry[],
  projected: UiPart[],
): ProjectionResult {
  const encoded = branch.findLast(
    (entry) => entry.type === "custom" && entry.customType === forkDisplayProvenanceEntryType,
  );
  if (!encoded || encoded.type !== "custom") return { valid: true, parts: projected };
  const decoded = decodeForkDisplayProvenance(encoded.data);
  if (Option.isNone(decoded)) return { valid: false };

  const projectedIds = new Set(projected.map((part) => part.id));
  const grouped = new Map<string | null, UiPart[]>();
  for (const group of decoded.value.groups) {
    if (
      grouped.has(group.precedingPartId) ||
      group.parts.some((part) => projectedIds.has(part.id)) ||
      (group.precedingPartId !== null && !projectedIds.has(group.precedingPartId))
    )
      return { valid: false };
    grouped.set(group.precedingPartId, [...group.parts]);
  }

  const parts = [...(grouped.get(null) ?? [])];
  for (const part of projected) {
    parts.push(part, ...(grouped.get(part.id) ?? []));
  }
  return { valid: true, parts };
}

function projectBranch(branch: readonly SessionEntry[], live: boolean): ProjectionResult {
  return applyForkDisplayProvenance(branch, projectSessionEntries(branch, branch, { live }));
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
  if (!located) return projectBranch(branch, live);
  const replay = validateReplay(session, branch, located.index, located.provenance);
  if (!replay) return projectBranch(branch, live);

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
  return applyForkDisplayProvenance(branch, [
    ...markerParts,
    ...reconstructedPrefix,
    ...postCompactionParts,
  ]);
}

function reconstructForkPrefix(
  session: SessionManager,
  contextLeafId: string,
  targetEntryId: string,
  visitedLeaves: ReadonlySet<string>,
  depth: number,
): ProjectionResult {
  const contextBranch = session.getBranch(contextLeafId);
  const resolvedLeafId = contextBranch.at(-1)?.id;
  if (!resolvedLeafId || depth > maximumProvenanceDepth || visitedLeaves.has(resolvedLeafId))
    return { valid: false };
  const targetIndex = contextBranch.findIndex((entry) => entry.id === targetEntryId);
  if (targetIndex < 0) return { valid: false };

  // A fork point inside replayed dialogue precedes the provenance entry that
  // explains that dialogue. Resolve it from the containing branch rather than
  // projecting the raw prefix and silently dropping its historical work.
  for (
    let provenanceIndex = contextBranch.length - 1;
    provenanceIndex > targetIndex;
    provenanceIndex -= 1
  ) {
    const entry = contextBranch[provenanceIndex];
    if (entry?.type !== "custom" || entry.customType !== toolCompactProvenanceEntryType) continue;
    const parsed = Schema.decodeUnknownOption(toolCompactProvenanceSchema)(entry.data);
    if (Option.isNone(parsed)) continue;
    const mappingIndex = parsed.value.mappings.findIndex(
      (mapping) => mapping.replayedEntryId === targetEntryId,
    );
    if (mappingIndex < 0) continue;
    const replay = validateReplay(session, contextBranch, provenanceIndex, parsed.value);
    if (!replay) return { valid: false };

    const targetMapping = parsed.value.mappings[mappingIndex];
    if (!targetMapping) return { valid: false };
    const source = reconstructForkPrefix(
      session,
      parsed.value.sourceLeafId,
      targetMapping.sourceEntryId,
      new Set([...visitedLeaves, resolvedLeafId]),
      depth + 1,
    );
    if (!source.valid) return source;

    const replacements = new Map<string, UiPart>();
    for (const mapping of parsed.value.mappings.slice(0, mappingIndex + 1)) {
      const sourceEntry = session.getEntry(mapping.sourceEntryId);
      const replayedEntry = session.getEntry(mapping.replayedEntryId);
      if (!sourceEntry || !replayedEntry) return { valid: false };
      const sourceDialogue = projectedDialogueParts(sourceEntry);
      const replayedDialogue = projectedDialogueParts(replayedEntry);
      if (!dialoguePartsCorrespond(sourceDialogue, replayedDialogue)) return { valid: false };
      sourceDialogue.forEach((part, index) => {
        const replacement = replayedDialogue[index];
        if (replacement) replacements.set(part.id, replacement);
      });
    }

    const markerParts = projectSessionEntries(contextBranch.slice(0, replay.markerIndex + 1));
    return {
      valid: true,
      parts: [
        ...markerParts,
        ...source.parts.map((part) => replacements.get(part.id) ?? compactedPart(part)),
      ],
    };
  }

  return reconstruct(session, targetEntryId, visitedLeaves, depth, false);
}

/**
 * Projects the visible prefix selected by a normal message-level fork. Unlike
 * projecting the raw Pi prefix, this can consult provenance appended after a
 * replayed message while still excluding every later visible turn.
 */
export function projectConversationForkDisplay(session: SessionManager, entryId: string): UiPart[] {
  const activeLeafId = session.getLeafId();
  if (!activeLeafId) return [];
  const result = reconstructForkPrefix(session, activeLeafId, entryId, new Set(), 0);
  if (result.valid) return result.parts;
  return projectConversationDisplay(session, { leafId: entryId });
}

/**
 * Projects the Conversation timeline while recovering work logs from provenance-linked
 * inactive Pi branches. Pi's active branch remains the sole model-context branch.
 */
export function projectConversationDisplay(
  session: SessionManager,
  options: { readonly live?: boolean; readonly leafId?: string } = {},
): UiPart[] {
  const activeBranch = session.getBranch(options.leafId);
  const result = reconstruct(session, options.leafId, new Set(), 0, options.live === true);
  if (result.valid) return result.parts;
  const fallback = applyForkDisplayProvenance(
    activeBranch,
    projectSessionEntries(activeBranch, activeBranch, { live: options.live }),
  );
  return fallback.valid
    ? fallback.parts
    : projectSessionEntries(activeBranch, activeBranch, { live: options.live });
}
