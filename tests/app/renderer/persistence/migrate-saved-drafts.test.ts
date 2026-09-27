import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import type { Client } from "../../../../src/renderer/client/Client";
import { migrateSavedDrafts } from "../../../../src/renderer/persistence/migrate-saved-drafts";
import { extractSavedDrafts } from "../../../../src/services/storage/WindowStateStorage";

const savedId = "00000000-0000-4000-8000-000000000001";
const unsentId = "00000000-0000-4000-8000-000000000002";
const legacy = Schema.decodeUnknownSync(Schema.Json)({
  state: { selectedSessionId: savedId },
  children: {
    sessionRegistry: {
      state: {
        targets: [
          { sessionId: savedId, workspacePath: "/project" },
          { sessionId: unsentId, workspacePath: "/project" },
        ],
      },
      children: {
        pendingSessions: {
          state: { conversationIds: [savedId, unsentId], temporarySessionIds: [savedId, unsentId] },
          children: {
            conversations: [
              {
                key: savedId,
                state: {
                  name: "Saved",
                  draftPrompt: { text: "Initial saved task", attachments: [] },
                },
                children: {},
              },
              {
                key: unsentId,
                state: { name: "Unsent", localDraft: "New unsent input" },
                children: {},
              },
            ],
          },
        },
      },
    },
  },
});

const endpoint = (fail: "import" | "save" | undefined) => {
  const records = new Map<string, unknown>();
  const create = vi.fn(async (input: { sessionId?: string }) => {
    if (fail === "import") throw new Error("Endpoint unavailable");
    records.set(input.sessionId!, input);
    return input;
  });
  const save = vi.fn(async () => {
    if (fail === "save") throw new Error("Window disk unavailable");
  });
  const client = { savedDrafts: { create }, windowState: { save } } as unknown as Pick<
    Client,
    "savedDrafts" | "windowState"
  >;
  return { client, create, save, records };
};

describe.each(["local", "remote"])("%s endpoint legacy saved Draft startup", () => {
  it("imports stable IDs before stripping, preserving unsent input and selection", async () => {
    const server = endpoint(undefined);
    const snapshot = await migrateSavedDrafts(server.client, legacy);
    expect(server.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: savedId, text: "Initial saved task" }),
    );
    expect(server.save).toHaveBeenCalledOnce();
    expect(server.records.has(savedId)).toBe(true);
    expect(extractSavedDrafts(snapshot).records).toEqual([]);
    expect(snapshot).toMatchObject({
      state: { selectedSessionId: savedId },
      children: {
        sessionRegistry: {
          state: { targets: [{ sessionId: unsentId }] },
          children: {
            pendingSessions: {
              children: {
                conversations: [{ key: unsentId, state: { localDraft: "New unsent input" } }],
              },
            },
          },
        },
      },
    });
  });

  it.each(["import", "save"] as const)(
    "keeps the source snapshot on %s failure for a stable-ID retry",
    async (failure) => {
      const server = endpoint(failure);
      await expect(migrateSavedDrafts(server.client, legacy)).rejects.toThrow();
      expect(extractSavedDrafts(legacy).records).toMatchObject([
        { sessionId: savedId, text: "Initial saved task" },
      ]);
      expect(server.save).toHaveBeenCalledTimes(failure === "save" ? 1 : 0);
      const recovered = endpoint(undefined);
      await migrateSavedDrafts(recovered.client, legacy);
      expect(recovered.create.mock.calls[0]?.[0].sessionId).toBe(savedId);
    },
  );
});
