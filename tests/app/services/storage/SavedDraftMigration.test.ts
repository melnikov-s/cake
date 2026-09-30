import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { extractSavedDrafts } from "../../../../src/services/storage/WindowStateStorage";

const id = "00000000-0000-4000-8000-000000000001";
const stagedId = "00000000-0000-4000-8000-000000000002";
const invalidId = "00000000-0000-4000-8000-000000000003";

function legacyWindow() {
  return {
    state: { selectedSessionId: id },
    children: {
      sessionRegistry: {
        state: {
          targets: [
            { sessionId: id, workspacePath: "/project" },
            { sessionId: stagedId, workspacePath: "/project" },
            { sessionId: invalidId, workspacePath: "/project" },
          ],
        },
        children: {
          pendingSessions: {
            state: {
              conversationIds: [id, stagedId, invalidId],
              temporarySessionIds: [id, stagedId, invalidId],
              stagedSessionIds: [stagedId],
            },
            children: {
              conversations: [
                {
                  key: id,
                  state: {
                    name: "Saved",
                    draftPrompt: { text: "Saved request", attachments: [], resolved: false },
                    configuration: { provider: "openai", modelId: "gpt", thinkingLevel: "high" },
                  },
                  children: {},
                },
                {
                  key: stagedId,
                  state: { name: "Unsent", localDraft: "not saved" },
                  children: {},
                },
                {
                  key: invalidId,
                  state: {
                    draftPrompt: {
                      text: "Invalid saved request",
                      attachments: [{ kind: "invalid" }],
                    },
                  },
                  children: {},
                },
              ],
            },
          },
        },
      },
    },
  };
}

describe("saved Draft window migration", () => {
  it("extracts only valid explicitly saved records; preserves unsent and unrelated navigation", () => {
    const window = Schema.decodeUnknownSync(Schema.Json)(legacyWindow());
    const original = JSON.stringify(window);
    const { records, windowSnapshot } = extractSavedDrafts(window);
    expect(records).toMatchObject([
      { sessionId: id, text: "Saved request", configuration: { fastMode: false } },
    ]);
    expect(windowSnapshot).toMatchObject({
      state: { selectedSessionId: id },
      children: {
        sessionRegistry: {
          state: { targets: [{ sessionId: stagedId }, { sessionId: invalidId }] },
          children: {
            pendingSessions: {
              state: {
                conversationIds: [stagedId, invalidId],
                temporarySessionIds: [stagedId, invalidId],
                stagedSessionIds: [stagedId],
              },
              children: {
                conversations: [
                  { key: stagedId, state: { localDraft: "not saved" } },
                  { key: invalidId, state: { draftPrompt: { text: "Invalid saved request" } } },
                ],
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(window)).toBe(original);
    expect(Schema.decodeUnknownSync(Schema.Json)(windowSnapshot)).toEqual(windowSnapshot);
    expect(extractSavedDrafts(windowSnapshot).records).toEqual([]);
    expect(extractSavedDrafts(windowSnapshot).windowSnapshot).toBe(windowSnapshot);
  });

  it.each([
    null,
    false,
    42,
    "window",
    [],
    { children: [] },
    { children: { sessionRegistry: null } },
    { children: { sessionRegistry: { children: { pendingSessions: [] } } } },
    {
      children: {
        sessionRegistry: {
          state: { targets: [null, 42, [], { sessionId: id }] },
          children: {
            pendingSessions: {
              state: "invalid shape",
              children: { conversations: [null, 42, [], { key: id, state: false }] },
            },
          },
        },
      },
    },
  ])("leaves JSON without a legacy registry unchanged: %j", (window) => {
    const snapshot = Schema.decodeUnknownSync(Schema.Json)(window);
    expect(extractSavedDrafts(snapshot)).toEqual({ records: [], windowSnapshot: snapshot });
    expect(extractSavedDrafts(snapshot).windowSnapshot).toBe(snapshot);
  });

  it.each([false, true])(
    "does not traverse unrelated JSON subtrees (saved Draft present: %s)",
    (savedPresent) => {
      let unrelatedReads = 0;
      const legacy = legacyWindow();
      if (!savedPresent) {
        const pending = legacy.children.sessionRegistry.children.pendingSessions;
        pending.children.conversations = pending.children.conversations.filter(
          (record) => record.key !== id,
        );
      }
      const window = {
        ...legacy,
        children: {
          ...legacy.children,
          appShellStore: {
            state: {
              get sessionHistory() {
                unrelatedReads++;
                return [{ kind: "project-session", sessionId: stagedId }];
              },
            },
            children: {},
          },
        },
      };
      // Simulate the existing boundary validation before invoking the typed pure helper.
      const snapshot = Schema.decodeUnknownSync(Schema.Json)(window);
      unrelatedReads = 0;
      const extracted = extractSavedDrafts(snapshot);
      expect(extracted.records).toHaveLength(savedPresent ? 1 : 0);
      expect(unrelatedReads).toBe(0);
      if (savedPresent) expect(extracted.windowSnapshot).not.toBe(snapshot);
      else expect(extracted.windowSnapshot).toBe(snapshot);
    },
  );
});
