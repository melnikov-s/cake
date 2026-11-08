import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import * as metadata from "../../../../src/domain/cake-chats/cakeChatMetadata";
import { projectLocation } from "../../../../src/domain/cake-chats/cakeChatLocations";
import { CakeSessionRuntimes } from "../../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../../src/services/storage/ApplicationState";
import { readDurableChatSummary } from "../../../../src/services/pi-durable/durable-chat-catalog";
import { ChatMetadataDoc } from "../../../../src/services/pi-durable/durable-chat-metadata";

/** Controlled critical-path comparison, not an end-to-end launch benchmark. Each read
 * reopens SQLite; OS caches are warm. Seeding is outside all measured intervals. */
it.each([
  { projects: 0, entries: 0 },
  { projects: 24, entries: 500 },
])(
  "isolated catalog-gated versus exact startup: $projects projects / $entries entries per chat",
  async ({ projects, entries }) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-selected-startup-"));
    const location = {
      workingDirectory: directory,
      sessionDirectory: join(directory, "global-chat"),
    };
    const state = {
      ...defaultApplicationState(),
      projects: Array.from({ length: projects }, (_, i) => ({
        path: join(directory, `project-${i}`),
        name: `Project ${i}`,
        addedAt: "2026-01-01T00:00:00Z",
        lastOpenedAt: "2026-01-01T00:00:00Z",
      })),
    };
    try {
      for (const target of [
        location,
        ...state.projects.map((project) => projectLocation(location, project.path)),
      ]) {
        await mkdir(target.sessionDirectory, { recursive: true });
        const harness = await Harness.open(
          await openNodeSqliteStorage(join(target.sessionDirectory, "coordinator.sqlite")),
          { models: createModels(), registry: createRegistry() },
          BACKGROUND_CONTEXT,
        );
        try {
          const root = await harness.root(BACKGROUND_CONTEXT);
          await root.commit(async (tx) => {
            const chat = await tx.doc(ChatMetadataDoc, root.id);
            chat.messageCount = entries;
            for (let i = 0; i < entries; i++)
              await tx.appendEntry(root.id, {
                kind: "pi.user",
                model: [
                  {
                    role: "user",
                    content: `Historical message ${i}: ${"fixture ".repeat(64)}`,
                    timestamp: i,
                  },
                ],
              });
          }, BACKGROUND_CONTEXT);
        } finally {
          await harness.close(BACKGROUND_CONTEXT);
        }
      }
      const open = vi.spyOn(Harness, "open");
      try {
        let reads = 0;
        const layer = Layer.mergeAll(
          Layer.mock(ApplicationState, { snapshot: () => state }),
          Layer.mock(CakeSessionRuntimes, {
            catalogEntry: (query, id) =>
              Effect.promise(() => {
                reads++;
                return readDurableChatSummary(query.sessionDirectory, id);
              }),
            currentStatus: () => Effect.succeed(undefined),
          }),
        );
        const samples: { catalogGatedMs: number; exactMs: number }[] = [];
        for (let i = 0; i < 3; i++) {
          const measure = async (exact: boolean) => {
            reads = 0;
            const started = performance.now();
            const result = exact
              ? await Effect.runPromise(
                  metadata.lookup(CAKE_CHAT_SESSION_ID, location).pipe(Effect.provide(layer)),
                )
              : (
                  await Effect.runPromise(metadata.catalog(location).pipe(Effect.provide(layer)))
                )[0];
            const elapsed = performance.now() - started;
            expect(result?.sessionId).toBe(CAKE_CHAT_SESSION_ID);
            expect(reads).toBe(exact ? 1 : projects + 1);
            return elapsed;
          };
          if (i % 2) {
            const exactMs = await measure(true);
            samples.push({ exactMs, catalogGatedMs: await measure(false) });
          } else {
            const catalogGatedMs = await measure(false);
            samples.push({ catalogGatedMs, exactMs: await measure(true) });
          }
        }
        expect(open).not.toHaveBeenCalled();
        console.info(
          "[cake.selected-startup-fixture]",
          JSON.stringify({ projects, entriesPerChat: entries, samples }),
        );
      } finally {
        open.mockRestore();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
