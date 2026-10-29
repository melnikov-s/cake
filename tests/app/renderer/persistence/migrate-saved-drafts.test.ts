import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import type { Client } from "../../../../src/renderer/client/Client";
import { migrateSavedDrafts } from "../../../../src/renderer/persistence/migrate-saved-drafts";
import { extractSavedDrafts } from "../../../../src/contracts/project-sessions/saved-draft-extraction";
import { fakeSavedDrafts } from "../fakes/saved-drafts";
import { createTestClient } from "../test-client";

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
  const drafts = fakeSavedDrafts();
  const create = vi.fn<Client["savedDrafts"]["create"]>(async (input) => {
    if (fail === "import") throw new Error("Endpoint unavailable");
    return drafts.client.create(input);
  });
  const save = vi.fn<Client["windowState"]["save"]>(async () => {
    if (fail === "save") throw new Error("Window disk unavailable");
    // Saving a stripped window before the authority accepts its Draft would lose user data.
    expect(drafts.records.get(savedId)).toMatchObject({ text: "Initial saved task" });
  });
  const client = createTestClient({
    savedDrafts: { ...drafts.client, create },
    windowState: { save },
  });
  return { client, create, save, records: drafts.records };
};

// Startup migration runs before React mounts. These tests retain the persisted-data boundary:
// UI rendering cannot prove import-before-strip ordering or preserve the source after an I/O failure.
describe("legacy saved Draft startup migration", () => {
  it("imports stable IDs before stripping, preserving unsent input and selection", async () => {
    const server = endpoint(undefined);
    const snapshot = await migrateSavedDrafts(server.client, legacy);
    expect(server.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: savedId, text: "Initial saved task" }),
    );
    expect(server.save).toHaveBeenCalledOnce();
    expect(server.records.get(savedId)).toMatchObject({
      sessionId: savedId,
      projectPath: "/project",
      status: "saved",
      revision: 1,
    });
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
      const before = structuredClone(legacy);
      await expect(migrateSavedDrafts(server.client, legacy)).rejects.toThrow(
        failure === "import" ? "Endpoint unavailable" : "Window disk unavailable",
      );
      expect(legacy).toEqual(before);
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
