import { Predicate, Schema } from "effect";
import { SavedDraft, type SavedDraft as SavedDraftValue } from "./saved-draft-data";

export const decodeStringArray = (value: Schema.Schema.Type<typeof Schema.Json> | undefined) => {
  const result = Schema.decodeUnknownResult(Schema.Array(Schema.String))(value);
  return result._tag === "Success" ? [...result.success] : [];
};

export const decodeString = (value: Schema.Schema.Type<typeof Schema.Json> | undefined) => {
  const result = Schema.decodeUnknownResult(Schema.String)(value);
  return result._tag === "Success" ? result.success : undefined;
};

/* Saved Drafts predate backend authority. Only explicit saved records migrate;
 * unsent composer text and staged navigation stay window-local. Callers must
 * persist the stripped snapshot only after all imports have committed. */
export interface SavedDraftExtraction {
  readonly records: ReadonlyArray<SavedDraftValue>;
  readonly windowSnapshot: Schema.Schema.Type<typeof Schema.Json>;
}

export const extractSavedDrafts = (
  snapshot: Schema.Schema.Type<typeof Schema.Json>,
): SavedDraftExtraction => {
  // The caller has already normalized or decoded JSON. Inspect only the legacy path;
  // recursively decoding each ancestor revalidates unrelated navigation/composer trees.
  const jsonRecord = (
    value: Schema.Schema.Type<typeof Schema.Json> | undefined,
  ): Schema.JsonObject | undefined => {
    // SAFETY: Input is already JSON; Predicate.isObject excludes null/arrays, leaving only JsonObject.
    return Predicate.isObject(value) ? (value as Schema.JsonObject) : undefined;
  };
  const root = jsonRecord(snapshot);
  const children = jsonRecord(root?.children);
  const registry = jsonRecord(children?.sessionRegistry);
  const registryChildren = jsonRecord(registry?.children);
  const pending = jsonRecord(registryChildren?.pendingSessions);
  const pendingChildren = jsonRecord(pending?.children);
  const conversations = Array.isArray(pendingChildren?.conversations)
    ? pendingChildren.conversations
    : [];
  const targetsValue = jsonRecord(registry?.state)?.targets;
  const targets = Array.isArray(targetsValue) ? targetsValue : [];
  const records: SavedDraftValue[] = [];
  const migratedIds = new Set<string>();
  for (const item of conversations) {
    const conversation = jsonRecord(item);
    const sessionId = decodeString(conversation?.key);
    const state = jsonRecord(conversation?.state);
    const prompt = jsonRecord(state?.draftPrompt);
    const target = targets.map(jsonRecord).find((candidate) => candidate?.sessionId === sessionId);
    const projectPath = decodeString(target?.workspacePath);
    if (!sessionId || !projectPath || !prompt) continue;
    const legacyConfiguration = jsonRecord(state?.configuration);
    const candidate = {
      sessionId,
      projectPath,
      workingDirectory: projectPath,
      title: decodeString(state?.name) ?? decodeString(state?.fallbackTitle) ?? "New chat",
      text: decodeString(prompt.text) ?? "",
      attachments: prompt.attachments ?? [],
      ...(legacyConfiguration
        ? {
            configuration: {
              provider: legacyConfiguration.provider,
              modelId: legacyConfiguration.modelId,
              thinkingLevel: legacyConfiguration.thinkingLevel ?? "off",
              fastMode: legacyConfiguration.fastMode ?? false,
            },
          }
        : null),
      labelIds: state?.labelIds ?? [],
      resolved: prompt.resolved === true,
      createdAt: decodeString(state?.createdAt) ?? new Date(0).toISOString(),
      modifiedAt: decodeString(state?.modifiedAt) ?? new Date(0).toISOString(),
      revision: 1,
      status: "saved",
    };
    const decoded = Schema.decodeUnknownResult(SavedDraft)(candidate);
    if (decoded._tag !== "Success") continue;
    records.push(decoded.success);
    migratedIds.add(sessionId);
  }
  if (
    !migratedIds.size ||
    !root ||
    !children ||
    !registry ||
    !registryChildren ||
    !pending ||
    !pendingChildren
  )
    return { records, windowSnapshot: snapshot };
  const pendingState = jsonRecord(pending.state) ?? {};
  const registryState = jsonRecord(registry.state) ?? {};
  const filterIds = (value: Schema.Schema.Type<typeof Schema.Json> | undefined) =>
    decodeStringArray(value).filter((id) => !migratedIds.has(id));
  const windowSnapshot: Schema.Schema.Type<typeof Schema.Json> = {
    ...root,
    children: {
      ...children,
      sessionRegistry: {
        ...registry,
        state: {
          ...registryState,
          targets: targets.filter(
            (item) => !migratedIds.has(decodeString(jsonRecord(item)?.sessionId) ?? ""),
          ),
        },
        children: {
          ...registryChildren,
          pendingSessions: {
            ...pending,
            state: {
              ...pendingState,
              conversationIds: filterIds(pendingState.conversationIds),
              temporarySessionIds: filterIds(pendingState.temporarySessionIds),
              stagedSessionIds: filterIds(pendingState.stagedSessionIds),
            },
            children: {
              ...pendingChildren,
              conversations: conversations.filter(
                (item) => !migratedIds.has(decodeString(jsonRecord(item)?.key) ?? ""),
              ),
            },
          },
        },
      },
    },
  };
  // Copying JSON subtrees and filtering arrays preserves JSON validity. Boundary
  // validation remains with RPC/storage; extraction does not need another full walk.
  return { records, windowSnapshot };
};
