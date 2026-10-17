import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import * as inbox from "../../../src/domain/conversations/completionInbox";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

it.effect(
  "pages every retained decision, scopes recipients, and never rearms deferred/dismissed results",
  () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const item = {
        id: "result",
        coordinatorSessionId: "parent",
        sessionId: "child",
        title: "Research",
        summary: "Investigation complete",
        reportedAt: "2026-01-01",
        kind: "investigation" as const,
        status: "completed" as const,
      };
      for (let i = 0; i < 55; i++) yield* inbox.queue({ ...item, id: "result-" + i });
      const page = yield* inbox.list("parent", { limit: 50 });
      expect(page.items).toHaveLength(50);
      expect(page.nextOffset).toBe(50);
      expect((yield* inbox.list("parent", { offset: page.nextOffset! })).items).toHaveLength(5);
      expect((yield* inbox.list("other")).total).toBe(0);
      expect((yield* inbox.list("parent", { query: "research", limit: 1 })).total).toBe(55);
      expect(page.items[0]?.decisions).not.toContain("merge");
      yield* inbox.update("parent", { id: "result-0", state: "deferred" });
      yield* inbox.update("parent", { id: "result-1", state: "dismissed" });
      yield* inbox.queue({ ...item, id: "result-0" });
      yield* inbox.queue({ ...item, id: "result-1" });
      const state = yield* storage.state();
      expect(state.completionInbox).toHaveLength(55);
      expect(state.coordinatorDigest).toHaveLength(53);
      expect((yield* inbox.list("parent")).total).toBe(54);
    }).pipe(Effect.provide(familyStorageHarness().layer)),
);
