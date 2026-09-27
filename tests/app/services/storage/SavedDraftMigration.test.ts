import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { extractSavedDrafts } from "../../../../src/services/storage/WindowStateStorage";

const id = "00000000-0000-4000-8000-000000000001";
const stagedId = "00000000-0000-4000-8000-000000000002";

describe("saved Draft window migration", () => {
  it("extracts only explicitly saved records; preserves unsent and unrelated navigation", () => {
    const window = {
      state: { selectedSessionId: id },
      children: {
        sessionRegistry: {
          state: {
            targets: [
              { sessionId: id, workspacePath: "/project" },
              { sessionId: stagedId, workspacePath: "/project" },
            ],
          },
          children: {
            pendingSessions: {
              state: {
                conversationIds: [id, stagedId],
                temporarySessionIds: [id, stagedId],
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
                ],
              },
            },
          },
        },
      },
    };
    const { records, windowSnapshot } = extractSavedDrafts(
      Schema.decodeUnknownSync(Schema.Json)(window),
    );
    expect(records).toMatchObject([
      { sessionId: id, text: "Saved request", configuration: { fastMode: false } },
    ]);
    expect(windowSnapshot).toMatchObject({
      state: { selectedSessionId: id },
      children: {
        sessionRegistry: {
          state: { targets: [{ sessionId: stagedId }] },
          children: {
            pendingSessions: {
              state: {
                conversationIds: [stagedId],
                temporarySessionIds: [stagedId],
                stagedSessionIds: [stagedId],
              },
              children: { conversations: [{ key: stagedId, state: { localDraft: "not saved" } }] },
            },
          },
        },
      },
    });
  });
});
