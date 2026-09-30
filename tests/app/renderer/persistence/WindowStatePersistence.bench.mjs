// Run: CAKE_PERSISTENCE_BASELINE=<before-revision> pnpm exec vitest bench --run tests/app/renderer/persistence/WindowStatePersistence.bench.mjs --reporter=default
// Synthetic cached Store snapshot only; no user state, disk saves, RPC, or live-app claim.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { bench, describe } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Schema } from "effect";

const revision = process.env.CAKE_PERSISTENCE_BASELINE;
if (!revision)
  throw new Error(
    "Set CAKE_PERSISTENCE_BASELINE to the Git revision before the persistence change",
  );
const directory = await mkdtemp(join(process.cwd(), ".persistence-benchmark-"));
try {
  const sourcePath = "src/services/storage/WindowStateStorage.ts";
  const baselineSource = execFileSync("git", ["show", `${revision}:${sourcePath}`], {
    encoding: "utf8",
  });
  const baselinePath = join(directory, "before.mjs");
  const currentPath = join(directory, "after.mjs");
  const options = {
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  };
  await build({
    ...options,
    stdin: { contents: baselineSource, resolveDir: resolve("src/services/storage"), loader: "ts" },
    outfile: baselinePath,
  });
  await build({ ...options, entryPoints: [sourcePath], outfile: currentPath });
  const before = (await import(pathToFileURL(baselinePath).href)).extractSavedDrafts;
  const after = (await import(pathToFileURL(currentPath).href)).extractSavedDrafts;
  const id = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const store = (state = {}, children = {}) => ({ state, children });
  const sessions = Array.from({ length: 429 }, (_, index) => ({
    key: id(index),
    ...store(
      { presentationMode: "normal" },
      {
        conversationSessionStore: store(
          {},
          {
            composerStore: store(
              {},
              {
                draftStore: store({
                  text: index === 0 ? "unsent request" : "",
                  attachments:
                    index === 0
                      ? [{ kind: "file", name: "notes.txt", path: "/projects/example/notes.txt" }]
                      : [],
                  annotations: [],
                  editorContextAttachment: undefined,
                }),
                queueStore: store(),
                deliveryStore: store(),
              },
            ),
            chatStore: store(
              { localDraft: "" },
              { transcriptStore: store(), interactionStore: store() },
            ),
            configurationStore: store(),
          },
        ),
        ...Object.fromEntries(
          [
            "worktreeStore",
            "presentationStore",
            "stagedCommandStore",
            "sessionAssistantStore",
            "reviewStore",
            "artifactsStore",
            "discussionsStore",
            "scheduledMessagesStore",
            "subagentsStore",
            "terminalStore",
          ].map((name) => [name, store()]),
        ),
      },
    ),
  }));
  const snapshot = store(
    {},
    {
      appShellStore: store({
        selection: { kind: "project-session", sessionId: id(0) },
        sessionHistory: Array.from({ length: 7500 }, (_, index) => ({
          kind: "project-session",
          sessionId: id(index % sessions.length),
        })),
        sessionHistoryCursor: 7499,
      }),
      sessionRegistry: store(
        {
          targets: sessions.map(({ key }) => ({
            sessionId: key,
            workspacePath: "/projects/example",
          })),
        },
        {
          sessions,
          pendingSessions: store(
            { conversationIds: [], temporarySessionIds: [], stagedSessionIds: [] },
            { conversations: [] },
          ),
        },
      ),
      sessionLayoutStore: store({
        layout: {
          kind: "pane",
          paneId: "pane",
          history: sessions.map(({ key }) => key),
          historyCursor: 0,
        },
        focusedPaneId: "pane",
      }),
    },
  );
  const beforeProducer = () =>
    before(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(snapshot))))
      .windowSnapshot;
  const afterProducer = () => after(JSON.parse(JSON.stringify(snapshot))).windowSnapshot;
  if (JSON.stringify(beforeProducer()) !== JSON.stringify(afterProducer()))
    throw new Error("Payload changed");
  describe(`producer normalization/extraction: ${Buffer.byteLength(JSON.stringify(snapshot))} bytes, 429 sessions, 7500 history entries`, () => {
    bench("before", beforeProducer);
    bench("after", afterProducer);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
