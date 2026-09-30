import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { _electron as electron, expect, test, type CDPSession } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const baselineRoot = process.env.CAKE_PERFORMANCE_BASELINE_APP;
const sessionCount = 429;
const historyCount = 7500;
const iterations = 12;
const timestamp = "2026-01-01T00:00:00.000Z";
const id = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const title = (index: number) => `Performance transcript ${index}`;
const store = (state: object = {}, children: object = {}) => ({ state, children });

type SwitchSample = {
  sessionId: string;
  startedAt: number;
  transcriptCommitMs?: number;
  frameBoundaryMs?: number;
};
type TraceEvent = {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { type?: string } };
};
type RunResult = {
  variant: "baseline" | "patched";
  clickDispatchMs: number[];
  frameBoundaryMs: number[];
  transcriptCommitMs: number[];
  postClickLongestTaskMs: number[];
  longTaskTotalMs: number[];
  normalizedWindowBytes: number;
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cake-switching-performance-"));
  const project = join(directory, "project");
  const home = join(directory, "cake-home");
  const userData = join(directory, "user-data");
  const sessions = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  await Promise.all(
    [userData, project, sessions, join(home, "state"), join(home, "pi")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const targets = Array.from({ length: sessionCount }, (_, index) => ({
    sessionId: id(index),
    workspacePath: project,
  }));
  const persistedSessions = targets.map(({ sessionId }) => ({
    key: sessionId,
    ...store(
      {
        presentationMode: "normal",
        workspaceChatSidebarVisible: true,
        workspaceChatSidebarWidth: 420,
      },
      {
        ...Object.fromEntries(
          [
            "editorSelectionsStore",
            "drawStore",
            "sessionAssistantStore",
            "worktreeStore",
            "subagentActivityStore",
            "stagedCommandStore",
            "sessionArtifactsStore",
            "artifactInteractionStore",
            "messageCommentsStore",
          ].map((name) => [name, store()]),
        ),
        conversationSessionStore: store(
          {},
          {
            configurationStore: store(),
            sideChatStore: store(),
            composerStore: store(
              {},
              {
                draftStore: store({ text: "", attachments: [], annotations: [] }),
                deliveryStore: store(),
                promptQueueStore: store(),
                pendingSessionDraftStore: store(),
              },
            ),
            chatStore: store(
              { localDraft: "" },
              {
                transcriptInteraction: store(),
                workLogPresentation: store(),
                scheduledMessageInteraction: store(),
                promptCache: store(),
              },
            ),
          },
        ),
      },
    ),
  }));
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      version: 12,
      data: store(
        {},
        {
          appShellStore: store({
            selection: { kind: "project-session", sessionId: id(0) },
            activeConversation: { kind: "project-session", sessionId: id(0) },
            sessionHistory: Array.from({ length: historyCount }, (_, index) => ({
              kind: "project-session",
              sessionId: id(index % sessionCount),
            })),
            sessionHistoryCursor: historyCount - 1,
          }),
          projectWorkbenchStore: store(
            {},
            {
              projectOpenStore: store({ projectPath: project }),
            },
          ),
          projectCatalogStore: store({ projectOrder: [project] }),
          sessionRegistry: store(
            { targets },
            {
              sessions: persistedSessions,
              // Both switching destinations have materialized identities; the other
              // retained registry entries amplify lookup cost without opening runtimes.
              observationRetention: store({ materializedSessionIds: [id(0), id(1)] }),
            },
          ),
          sessionLayoutStore: store({
            layout: {
              kind: "pane",
              paneId: "performance-pane",
              history: [id(0)],
              historyCursor: 0,
            },
            focusedPaneId: "performance-pane",
          }),
        },
      ),
    }),
  );
  await writeFile(
    join(home, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Performance project", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [project],
    }),
  );
  await writeFile(
    join(home, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "performance-fixture": {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-only-no-requests",
          api: "openai-completions",
          models: Array.from({ length: 250 }, (_, index) => ({
            id: `fixture-model-${index}`,
            name: `Fixture model ${index}`,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 1024,
          })),
        },
      },
    }),
  );
  await Promise.all(
    targets.map(async ({ sessionId }, index) => {
      const entries = [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          provider: "performance-fixture",
          modelId: "fixture-model-0",
        },
        {
          type: "message",
          id: "user",
          parentId: "model",
          timestamp,
          message: { role: "user", content: [{ type: "text", text: title(index) }], timestamp: 0 },
        },
      ];
      const path = join(sessions, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
      await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const modified = new Date(index < 2 ? timestamp : "2025-01-01T00:00:00.000Z");
      await utimes(path, modified, modified);
    }),
  );
  return { directory, userData, home };
}

async function finishTrace(cdp: CDPSession) {
  const complete = new Promise<{ stream: string }>((done) =>
    cdp.once("Tracing.tracingComplete", done),
  );
  await cdp.send("Tracing.end");
  const { stream } = await complete;
  let text = "";
  for (;;) {
    const chunk: { data: string; eof: boolean; base64Encoded?: boolean } = await cdp.send(
      "IO.read",
      { handle: stream },
    );
    text += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  return text;
}

function summarizeTrace(events: TraceEvent[]) {
  const renderer = events.find(
    (event) => event.name === "thread_name" && event.args?.name === "CrRendererMain",
  );
  if (!renderer) throw new Error("Renderer main thread is missing from trace");
  const main = events.filter((event) => event.pid === renderer.pid && event.tid === renderer.tid);
  const clicks = main.filter(
    (event) => event.name === "EventDispatch" && event.args?.data?.type === "click",
  );
  expect(clicks).toHaveLength(iterations);
  const tasks = main.filter((event) => event.name === "RunTask" && event.ph === "X");
  const windowEnd = (click: TraceEvent, index: number) => {
    const next = clicks[index + 1];
    const nextTask =
      next && tasks.find((task) => task.ts <= next.ts && task.ts + (task.dur ?? 0) > next.ts);
    return nextTask?.ts ?? click.ts + 1_000_000;
  };
  return {
    clickDispatchMs: clicks.map((click) => (click.dur ?? 0) / 1000),
    postClickLongestTaskMs: clicks.map((click, index) => {
      const end = windowEnd(click, index);
      const following = tasks.filter(
        (task) => task.ts >= click.ts + (click.dur ?? 0) && task.ts < end,
      );
      return Math.max(0, ...following.map((task) => (task.dur ?? 0) / 1000));
    }),
    longTaskTotalMs: clicks.map((click, index) => {
      // A click's enclosing task starts slightly before EventDispatch; exclude
      // the next click's entire enclosing task rather than counting it twice.
      const end = windowEnd(click, index);
      return tasks
        .filter(
          (task) =>
            task.ts < end && task.ts + (task.dur ?? 0) > click.ts && (task.dur ?? 0) >= 50_000,
        )
        .reduce((total, task) => total + (task.dur ?? 0) / 1000, 0);
    }),
  };
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    median: Number(
      ((sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2).toFixed(2),
    ),
    p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(2)),
    max: Number(sorted.at(-1)!.toFixed(2)),
  };
}

test("compares warm session switching in isolated baseline and patched Electron applications", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.skip(!baselineRoot, "Run scripts/measure-session-switching.mjs to build both revisions");
  test.setTimeout(240_000);
  const runs: RunResult[] = [];
  // ABBA order reduces the influence of machine warming and chronological drift.
  for (const [runIndex, variant] of (
    ["baseline", "patched", "patched", "baseline"] as const
  ).entries()) {
    const appRoot = variant === "baseline" ? baselineRoot! : repositoryRoot;
    const f = await fixture();
    const application = await electron.launch({
      args: [appRoot],
      cwd: appRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: f.userData,
        CAKE_HOME: f.home,
      },
    });
    try {
      const page = await application.firstWindow();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const transcript = page.locator(".transcript");
      await expect(transcript.getByText(title(0), { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const clickSession = async (index: number) => {
        await page.locator(`.session-item[data-session-id="${id(index)}"] .session-row`).click();
        await expect(transcript.getByText(title(index), { exact: true })).toBeVisible();
      };
      // Hydrate both destinations and warm ordinary JS/render paths before tracing.
      for (const index of [1, 0, 1, 0]) await clickSession(index);
      await expect
        .poll(async () => {
          const saved = JSON.parse(await readFile(join(f.userData, "window-state.json"), "utf8"));
          return saved.data.children.appShellStore.state.selection.sessionId;
        })
        .toBe(id(0));
      await page.evaluate(() => {
        const state: { samples: SwitchSample[] } = { samples: [] };
        Object.assign(window, { cakeSwitchPerformance: state });
        document.addEventListener(
          "click",
          (event) => {
            if (!(event.target instanceof Element)) return;
            const sessionId = event.target.closest<HTMLElement>(".session-item")?.dataset.sessionId;
            if (!sessionId) return;
            const sample: SwitchSample = { sessionId, startedAt: performance.now() };
            state.samples.push(sample);
            const marker = `Performance transcript ${Number(sessionId.slice(-12)) - 1}`;
            const commit = new MutationObserver(() => {
              if (document.querySelector(".transcript")?.textContent?.includes(marker)) {
                sample.transcriptCommitMs = performance.now() - sample.startedAt;
                commit.disconnect();
              }
            });
            commit.observe(document.body, { childList: true, characterData: true, subtree: true });
            const nextFrame = () => {
              if (!document.querySelector(".transcript")?.textContent?.includes(marker)) {
                requestAnimationFrame(nextFrame);
                return;
              }
              // The following frame boundary is a paint opportunity, not proof of compositor presentation.
              requestAnimationFrame(() => {
                sample.frameBoundaryMs = performance.now() - sample.startedAt;
              });
            };
            requestAnimationFrame(nextFrame);
          },
          true,
        );
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Tracing.start", {
        categories:
          "devtools.timeline,v8,toplevel,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler,disabled-by-default-v8.cpu_profiler.hires",
        transferMode: "ReturnAsStream",
      });
      for (let iteration = 0; iteration < iterations; iteration++) {
        const index = iteration % 2 === 0 ? 1 : 0;
        await clickSession(index);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const state = Reflect.get(window, "cakeSwitchPerformance") as {
                samples: SwitchSample[];
              };
              return state.samples.at(-1)?.frameBoundaryMs !== undefined;
            }),
          )
          .toBe(true);
        // Deliberate sampling interval: include the 180ms persistence debounce and
        // its delayed work before the next input. This is not test synchronization.
        await page.waitForTimeout(600);
      }
      const trace = await finishTrace(cdp);
      await writeFile(testInfo.outputPath(`${runIndex}-${variant}-trace.json`), trace);
      const samples: SwitchSample[] = await page.evaluate(
        () => Reflect.get(window, "cakeSwitchPerformance").samples,
      );
      expect(samples).toHaveLength(iterations);
      expect(failures).toEqual([]);
      const saved = JSON.parse(await readFile(join(f.userData, "window-state.json"), "utf8"));
      expect(saved.data.children.sessionRegistry.state.targets).toHaveLength(sessionCount);
      const result: RunResult = {
        variant,
        ...summarizeTrace(JSON.parse(trace).traceEvents),
        frameBoundaryMs: samples.map((sample) => sample.frameBoundaryMs!),
        transcriptCommitMs: samples.map((sample) => {
          expect(sample.transcriptCommitMs).toBeDefined();
          return sample.transcriptCommitMs!;
        }),
        normalizedWindowBytes: Buffer.byteLength(JSON.stringify(saved.data)),
      };
      runs.push(result);
      console.log(
        `${variant} run ${runIndex}: dispatch ${JSON.stringify(distribution(result.clickDispatchMs))}`,
      );
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }
  const metrics = [
    "clickDispatchMs",
    "transcriptCommitMs",
    "frameBoundaryMs",
    "postClickLongestTaskMs",
    "longTaskTotalMs",
  ] as const;
  const comparison = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      Object.fromEntries(
        (["baseline", "patched"] as const).map((variant) => [
          variant,
          distribution(runs.filter((run) => run.variant === variant).flatMap((run) => run[metric])),
        ]),
      ),
    ]),
  );
  const report = {
    baselineRevision: process.env.CAKE_PERFORMANCE_BASELINE_REVISION,
    patchedRevision: process.env.CAKE_PERFORMANCE_PATCHED_REVISION,
    scenario: {
      sessionCount,
      historyCount,
      addedAuthenticatedModels: 250,
      viewport: "1440x1000",
      iterationsPerRun: iterations,
      order: "ABBA",
      cpuProfiling: true,
    },
    limitations:
      "Generated workload, not the user's transcripts. Includes equal CPU-profiler overhead. Transcript commit measures DOM readiness, not pixel presentation. Smoke windows are hidden; the next-rAF frame metric includes fixture scheduling and is not a compositor presentation measurement. Timings are observations, not CI thresholds.",
    comparison,
    runs,
  };
  const reportPath = join(repositoryRoot, ".performance-captures/session-switching/summary.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await testInfo.attach("session-switch-performance", {
    path: reportPath,
    contentType: "application/json",
  });
});
