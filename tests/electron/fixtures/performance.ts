import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../../fixtures/performance/v1.json" with { type: "json" };
import { windowStateChildren, windowStateDocument, store } from "../../fixtures/window-state";
import { cakeWorkspaceSessionDirectory } from "../../../src/services/pi/runtime/session-discovery";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";

export { fixture };
export const sessionId = (index: number) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
export const marker = (index: number) => `Performance destination ${index}`;

export async function createPerformanceFixture(origin: string, samples: number) {
  const directory = await mkdtemp(join(tmpdir(), "cake-regression-"));
  const project = join(directory, "project");
  const home = join(directory, "home");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const count = Math.max(fixture.sessionCount, samples + 3);
  await Promise.all(
    [project, home, userData, sessions, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const children = windowStateChildren({ project, sessionId: sessionId(0), theme: "dark" });
  const targets = Array.from({ length: count }, (_, i) => ({
    sessionId: sessionId(i),
    workspacePath: project,
  }));
  children.appShellStore = store({
    navigationVersion: 2,
    workspace: "project-sessions",
    sessionHistory: Array.from({ length: fixture.navigationHistoryCount }, (_, i) => ({
      kind: "project-session",
      sessionId: sessionId((fixture.navigationHistoryCount - 1 - i) % count),
    })),
    sessionHistoryCursor: fixture.navigationHistoryCount - 1,
  });
  // Restored renderer identities and pane preferences, but no loaded transcript/runtime.
  children.sessionRegistry = store(
    { targets },
    {
      sessions: targets.map(({ sessionId }) => ({
        key: sessionId,
        ...store(
          { workspaceChatSidebarVisible: true, workspaceChatSidebarWidth: fixture.sidebarWidth },
          {
            conversationSessionStore: store(
              {},
              {
                composerStore: store(
                  {},
                  { draftStore: store({ text: "", attachments: [], annotations: [] }) },
                ),
                chatStore: store(),
              },
            ),
          },
        ),
      })),
      observationRetention: store({
        materializedSessionIds: targets.map((target) => target.sessionId),
      }),
    },
  );
  await writeFile(join(userData, "window-state.json"), windowStateDocument(children));
  const presetId = "00000000-0000-4000-9000-000000000001";
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 7,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: project,
            name: "Performance project",
            addedAt: fixture.timestamp,
            lastOpenedAt: fixture.timestamp,
          },
        ],
        trustedProjectPaths: [project],
        modelPresets: [
          {
            id: presetId,
            name: "Fixture",
            provider: "performance-fixture",
            modelId: "fixture",
            thinkingLevel: "off",
            fastMode: false,
          },
        ],
        defaultModelPresetId: presetId,
        // Automatic naming/labeling is not this workload; no utility model is configured.
      },
    }),
  );
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "performance-fixture": {
          baseUrl: `${origin}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );
  await Promise.all(
    targets.map(async ({ sessionId }, index) => {
      const entries: object[] = [
        { type: "session", version: 3, id: sessionId, timestamp: fixture.timestamp, cwd: project },
        {
          type: "session_info",
          id: "name",
          parentId: null,
          timestamp: fixture.timestamp,
          name: `Performance session ${index}`,
        },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp: fixture.timestamp,
          provider: "performance-fixture",
          modelId: "fixture",
        },
      ];
      for (let i = 0; i < fixture.messagesPerSession; i++) {
        const assistant = i % 2 === 0;
        entries.push({
          type: "message",
          id: `message-${i}`,
          parentId: i === 0 ? "model" : `message-${i - 1}`,
          timestamp: fixture.timestamp,
          message: {
            role: assistant ? "assistant" : "user",
            timestamp: i,
            content: [
              {
                type: "text",
                text:
                  i === fixture.messagesPerSession - 1
                    ? marker(index)
                    : `History ${i}: ${"A realistic conversation about implementation and verification. ".repeat(10)}\n\n\`\`\`ts\nconst message = ${i};\n\`\`\``,
              },
            ],
            ...(assistant
              ? {
                  api: "openai-completions",
                  provider: "performance-fixture",
                  model: "fixture",
                  stopReason: "stop",
                  usage: {
                    input: 100,
                    output: 50,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 150,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                }
              : {}),
          },
        });
      }
      await writeFile(
        join(sessions, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    }),
  );
  return {
    directory,
    project,
    home,
    cakeHome,
    userData,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
