import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { _electron as electron, expect, test, type CDPSession } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";
import { WINDOW_STATE_DOCUMENT_VERSION } from "../../src/services/storage/WindowStateStorage";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const baselineRoot = process.env.CAKE_PERFORMANCE_BASELINE_APP;
const reducedMotion =
  process.env.CAKE_PERFORMANCE_REDUCED_MOTION === "1" ? "reduce" : "no-preference";
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
  transcriptVisibleMs?: number;
  transcriptSettledMs?: number;
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
  transcriptVisibleMs: number[];
  transcriptSettledMs: number[];
  postClickLongestTaskMs: number[];
  longTaskTotalMs: number[];
  normalizedWindowBytes: number;
};

async function fixture(additionalChild = false) {
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
      version: WINDOW_STATE_DOCUMENT_VERSION,
      data: store(
        {},
        {
          appShellStore: store({
            navigationVersion: 2,
            workspace: "project-sessions",
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
  const transcriptTargets = additionalChild
    ? [...targets, { sessionId: id(sessionCount), workspacePath: project }]
    : targets;
  await Promise.all(
    transcriptTargets.map(async ({ sessionId }, index) => {
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
  return { directory, userData, home, project };
}

test("opens a new family child among hundreds of restored session identities", async () => {
  test.setTimeout(60_000);
  const f = await fixture(true);
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: f.userData,
      CAKE_HOME: f.home,
      PI_CODING_AGENT_DIR: join(f.home, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator(".transcript").getByText(title(0), { exact: true })).toBeVisible();
    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId: id(0),
      controlRequestId: "00000000-0000-4000-9000-000000000001",
      invocation: {
        _tag: "ProjectChildSession",
        childSessionId: id(sessionCount),
        title: title(sessionCount),
        familyId: "performance-family",
        familyChildOrder: 1,
        familyDepth: 1,
        workingDirectory: f.project,
        placement: "right",
      },
    });
    const parent = page.locator(`[data-slot="session-pane"][data-session-id="${id(0)}"]`);
    const child = page.locator(`[data-slot="session-pane"][data-session-id="${id(sessionCount)}"]`);
    await expect(parent.locator(".transcript").getByText(title(0), { exact: true })).toBeVisible();
    await expect(
      child.locator(".transcript").getByText(title(sessionCount), { exact: true }),
    ).toBeVisible();
    await expect(child).toHaveAttribute("data-focused", "true");
    expect(failures).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true });
  }
});

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
        PI_CODING_AGENT_DIR: join(f.home, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ reducedMotion });
      const transcript = page.locator(
        '.transcript:not([data-slot="content-transition-outgoing"] *)',
      );
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
          const layout = saved.data.children.sessionLayoutStore.state;
          return layout.layout.history[layout.layout.historyCursor];
        })
        .toBe(id(0));
      await page.evaluate(() => {
        const transcriptSelector = '.transcript:not([data-slot="content-transition-outgoing"] *)';
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
              if (document.querySelector(transcriptSelector)?.textContent?.includes(marker)) {
                sample.transcriptCommitMs = performance.now() - sample.startedAt;
                commit.disconnect();
              }
            });
            commit.observe(document.body, { childList: true, characterData: true, subtree: true });
            const nextFrame = () => {
              if (!document.querySelector(transcriptSelector)?.textContent?.includes(marker)) {
                requestAnimationFrame(nextFrame);
                return;
              }
              // The following frame boundary is a paint opportunity, not proof of compositor presentation.
              requestAnimationFrame(() => {
                sample.frameBoundaryMs = performance.now() - sample.startedAt;
              });
            };
            requestAnimationFrame(nextFrame);
            const visibleFrame = () => {
              // Only inspect live content: the outgoing inert clone can contain
              // the destination marker too during a rapid return switch.
              const transcript = document.querySelector<HTMLElement>(transcriptSelector);
              const list = transcript?.querySelector<HTMLElement>('[aria-label="Conversation"]');
              if (!list?.textContent?.includes(marker)) {
                requestAnimationFrame(visibleFrame);
                return;
              }
              let visible = true;
              let animating = false;
              for (
                let element: HTMLElement | null = list;
                element;
                element = element.parentElement
              ) {
                const style = getComputedStyle(element);
                if (
                  style.visibility !== "visible" ||
                  Number(style.opacity) === 0 ||
                  style.display === "none"
                )
                  visible = false;
                if (element.getAnimations().some((animation) => animation.playState === "running"))
                  animating = true;
              }
              if (visible) {
                sample.transcriptVisibleMs ??= performance.now() - sample.startedAt;
                if (!animating) {
                  sample.transcriptSettledMs = performance.now() - sample.startedAt;
                  return;
                }
              }
              requestAnimationFrame(visibleFrame);
            };
            requestAnimationFrame(visibleFrame);
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
              return state.samples.at(-1)?.transcriptSettledMs !== undefined;
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
        transcriptVisibleMs: samples.map((sample) => {
          expect(sample.transcriptVisibleMs).toBeDefined();
          return sample.transcriptVisibleMs!;
        }),
        transcriptSettledMs: samples.map((sample) => {
          expect(sample.transcriptSettledMs).toBeDefined();
          return sample.transcriptSettledMs!;
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
    "transcriptVisibleMs",
    "transcriptSettledMs",
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
      reducedMotion,
    },
    limitations:
      "Generated workload, not the user's transcripts. Includes equal CPU-profiler overhead. Transcript commit measures DOM readiness, not pixel presentation. Visible and settled metrics inspect computed visibility/opacity and ancestor animations at rAF opportunities with the recorded motion preference. Smoke windows are hidden; rAF metrics include fixture scheduling and are not compositor presentation measurements. Timings are observations, not CI thresholds.",
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
