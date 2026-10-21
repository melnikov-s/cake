import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function sessionTranscript(sessionId: string, project: string, title: string, count = 48) {
  const timestamp = new Date(0).toISOString();
  const entries: Array<Record<string, unknown>> = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
  ];
  let parentId: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const id = `${sessionId}-${index}`;
    const body = `${title} transcript item ${index}. ${"This line gives the virtualized message a distinct height. ".repeat((index % 6) + 1)}`;
    const text =
      index === 0
        ? title
        : index % 5 === 1
          ? `${body}\n\n\`\`\`ts\n${Array.from({ length: (index % 4) + 2 }, (_, line) => `const marker${index}_${line} = ${line};`).join("\n")}\n\`\`\``
          : body;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp,
      message:
        role === "user"
          ? { role, content: [{ type: "text", text }], timestamp: index }
          : {
              role,
              content: [{ type: "text", text }],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "fixture",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: index,
            },
    });
    parentId = id;
  }
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function streamingProvider(cakeHome: string) {
  let response: ServerResponse | undefined;
  const server = createServer((_request, nextResponse) => {
    response = nextResponse;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "scroll-provider": {
          name: "Scroll provider",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "scroll-model",
              name: "Scroll fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  const chunk = (text: string, finish: boolean) =>
    `data: ${JSON.stringify({
      id: "scroll-stream",
      object: "chat.completion.chunk",
      created: 0,
      model: "scroll-model",
      choices: [{ index: 0, delta: { content: text }, finish_reason: finish ? "stop" : null }],
    })}\n\n`;
  return {
    ready: () => Boolean(response),
    send(text: string) {
      if (!response) throw new Error("No provider request");
      response.write(chunk(text, false));
    },
    finish() {
      response?.end(chunk("", true) + "data: [DONE]\n\n");
    },
    async close() {
      response?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// Sample after the rendering update (all rAF callbacks and ResizeObservers), not
// at the start of rAF where a later callback could still correct before paint.
async function paintFrames(page: Page, count: number) {
  await page.evaluate(async (count) => {
    for (let frame = 0; frame < count; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }, count);
}

type TranscriptFrameSample = {
  gap: number;
  anchorId?: string;
  anchorText?: string | null;
  offset?: number;
};

async function startTranscriptFrameSamples(transcript: Locator) {
  await transcript.evaluate((element) => {
    const samples: TranscriptFrameSample[] = [];
    let frame: number;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(() => {
        const list = element.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
        if (list && getComputedStyle(list).visibility === "visible") {
          const top = element.getBoundingClientRect().top;
          const anchor = Array.from(
            element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
          ).find((item) => item.getBoundingClientRect().bottom > top + 1);
          samples.push({
            gap: element.scrollHeight - element.clientHeight - element.scrollTop,
            anchorId: anchor?.dataset.transcriptAnchorId,
            anchorText: anchor?.textContent,
            offset: anchor ? anchor.getBoundingClientRect().top - top : undefined,
          });
        }
        frame = requestAnimationFrame(tick);
      }, 0);
    };
    frame = requestAnimationFrame(tick);
    Object.assign(element, {
      stopFrameSamples: () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        return samples;
      },
    });
  });
}

async function stopTranscriptFrameSamples(transcript: Locator) {
  return transcript.evaluate((element) =>
    (element as HTMLElement & { stopFrameSamples(): TranscriptFrameSample[] }).stopFrameSamples(),
  );
}

async function transcriptAnchor(transcript: Locator) {
  return transcript.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const item = Array.from(
      element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
    ).find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1);
    if (!item) throw new Error("No visible transcript item");
    return {
      text: item.textContent,
      offset: item.getBoundingClientRect().top - viewportTop,
    };
  });
}

async function expectRestoredAnchor(
  transcript: Locator,
  saved: Awaited<ReturnType<typeof transcriptAnchor>>,
) {
  await expect
    .poll(async () => {
      try {
        const restored = await transcriptAnchor(transcript);
        return {
          textMatches: restored.text === saved.text,
          offsetDifference: Math.abs(restored.offset - saved.offset),
        };
      } catch {
        return {
          textMatches: false,
          offsetDifference: Number.POSITIVE_INFINITY,
        };
      }
    })
    .toEqual({ textMatches: true, offsetDifference: 0 });
}

for (const scenario of [
  "opens a restored transcript without renderer errors",
  "keeps every streaming frame at the bottom",
  "pauses streaming follow during message navigation and resumes past newest",
  "keeps user ownership through repeated streaming gestures",
  "keeps every resize frame at the bottom",
  "preserves the reading anchor during row resize",
  "reopens a large loaded session",
  "restores session position",
  "follows the full bottom and isolates nested scrolling",
  "escapes bottom following during height measurement",
  "keeps reading position while another session streams",
] as const) {
  test(scenario, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-scroll-smoke-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const firstSessionId = "scroll-session-first";
    const secondSessionId = "scroll-session-second";
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    const timestamp = new Date(0).toISOString();
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId: firstSessionId, theme: "dark" }),
    );
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
        trustedProjectPaths: [],
      }),
    );
    await Promise.all([
      writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${firstSessionId}.jsonl`),
        sessionTranscript(
          firstSessionId,
          project,
          "First scroll fixture",
          scenario === "reopens a large loaded session" ? 480 : 48,
        ),
      ),
      writeFile(
        join(sessionDirectory, `1970-01-01T00-00-01-000Z_${secondSessionId}.jsonl`),
        sessionTranscript(secondSessionId, project, "Second scroll fixture"),
      ),
    ]);

    const stream =
      scenario === "keeps reading position while another session streams" ||
      scenario === "keeps every streaming frame at the bottom" ||
      scenario === "pauses streaming follow during message navigation and resumes past newest" ||
      scenario === "keeps user ownership through repeated streaming gestures"
        ? await streamingProvider(cakeHome)
        : undefined;
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });

    try {
      const page = await application.firstWindow();
      // The outgoing transition snapshot is inert DOM, not a second live chat.
      const transcript = page.locator(
        '.transcript:not([data-slot="content-transition-outgoing"] *)',
      );
      const firstSession = page.locator(`.session-item[data-session-id="${firstSessionId}"]`);
      const secondSession = page.locator(`.session-item[data-session-id="${secondSessionId}"]`);
      await expect(transcript).toBeVisible({ timeout: 20_000 });
      await expect(firstSession).toHaveClass(/active/);
      await expect
        .poll(() =>
          transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);

      if (scenario === "opens a restored transcript without renderer errors") {
        // Reload the real restored window after attaching the listener so it
        // covers renderer startup, including the virtualizer's probe/measurement
        // commits. Do not intercept or suppress the browser's error events.
        await page.addInitScript(() => {
          const errors: string[] = [];
          Reflect.set(window, "startupRendererErrors", errors);
          window.addEventListener("error", (event) => errors.push(event.message));
        });
        for (let launch = 0; launch < 2; launch++) {
          await page.reload();
          await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
            "transcript item 47",
          );
          await paintFrames(page, 30);
          expect(await page.evaluate(() => Reflect.get(window, "startupRendererErrors"))).toEqual(
            [],
          );
          expect(
            await transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          ).toBeLessThanOrEqual(1);
        }
        return;
      }

      if (
        (scenario === "keeps every streaming frame at the bottom" ||
          scenario ===
            "pauses streaming follow during message navigation and resumes past newest" ||
          scenario === "keeps user ownership through repeated streaming gestures") &&
        stream
      ) {
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "transcript item 47",
        );
        await page.getByRole("button", { name: "Model configuration" }).click();
        await page.getByRole("button", { name: "Change model" }).click();
        await page.getByLabel("Search presets and models").fill("Scroll fixture");
        await page
          .getByRole("button", { name: /Scroll fixture/ })
          .first()
          .click();
        await page.getByRole("button", { name: "Apply", exact: true }).click();
        const composer = page.getByRole("combobox", { name: "Message" });
        await composer.click();
        await expect(composer).toBeFocused();
        await page.keyboard.type("Stream without jumping");
        await expect(composer).toHaveValue("Stream without jumping");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await page.keyboard.press("Enter");
        await expect.poll(stream.ready).toBe(true);
        stream.send("Initial streaming paragraph.\n\n");
        await expect(transcript).toContainText("Initial streaming paragraph.");
        await paintFrames(page, 6);
        if (
          scenario === "pauses streaming follow during message navigation and resumes past newest"
        ) {
          const selected = transcript.locator('[data-slot="transcript-item"][aria-current="true"]');
          await composer.press("ArrowUp");
          await expect(selected).toContainText("Initial streaming paragraph.");
          await paintFrames(page, 6);
          const selectedTop = await transcript.evaluate((element) => element.scrollTop);
          for (let index = 0; index < 4; index++) {
            stream.send(`Reading update ${index}. ${"More streaming. ".repeat(40)}\n\n`);
            await expect(selected).toContainText(`Reading update ${index}.`);
            await paintFrames(page, 6);
            expect(await transcript.evaluate((element) => element.scrollTop)).toBe(selectedTop);
          }
          // Navigating to an older message and back must not resume following.
          await composer.press("ArrowUp");
          await expect(selected).toContainText("Stream without jumping");
          await composer.press("ArrowDown");
          await expect(selected).toContainText("Initial streaming paragraph.");
          await paintFrames(page, 6);
          const readingTop = await transcript.evaluate((element) => element.scrollTop);
          stream.send(`Still reading. ${"More streaming. ".repeat(40)}\n\n`);
          await expect(selected).toContainText("Still reading.");
          await paintFrames(page, 6);
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(readingTop);
          // Only Down past newest returns to the full bottom and stream following.
          await composer.press("ArrowDown");
          await expect(selected).toHaveCount(0);
          await expect(composer).toBeFocused();
          for (let index = 0; index < 3; index++) {
            stream.send(`Following update ${index}. ${"More streaming. ".repeat(40)}\n\n`);
            await expect(transcript).toContainText(`Following update ${index}.`);
            await paintFrames(page, 6);
            expect(
              await transcript.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            ).toBeLessThanOrEqual(1);
          }
          stream.finish();
          await expect(firstSession.locator('[aria-label="Running"]')).toHaveCount(0);
          return;
        }
        if (scenario === "keeps user ownership through repeated streaming gestures") {
          await transcript.hover({ position: { x: 20, y: 200 } });
          for (let index = 0; index < 12; index++) {
            const before = await transcript.evaluate((element) => element.scrollTop);
            await page.mouse.wheel(0, -80);
            stream.send(`Gesture ${index}. ${"Streaming height update. ".repeat(15)}\n\n`);
            await paintFrames(page, 3);
            const after = await transcript.evaluate((element) => element.scrollTop);
            expect(after).toBeLessThan(before - 20);
          }
          const saved = await transcriptAnchor(transcript);
          for (let index = 0; index < 4; index++) {
            stream.send(`Passive update ${index}. ${"More streaming. ".repeat(30)}\n\n`);
            await paintFrames(page, 6);
            await expectRestoredAnchor(transcript, saved);
          }
          stream.finish();
          await expect(firstSession.locator('[aria-label="Running"]')).toHaveCount(0);
          await expectRestoredAnchor(transcript, saved);
          return;
        }
        await startTranscriptFrameSamples(transcript);
        for (let index = 0; index < 4; index++) {
          stream.send(
            Array.from(
              { length: 6 },
              (_, line) =>
                `Chunk ${index} paragraph ${line}. Streaming content changes the real message height.\n\n`,
            ).join(""),
          );
          await expect(transcript).toContainText(`Chunk ${index} paragraph 5.`);
          await paintFrames(page, 6);
        }
        stream.finish();
        await expect(firstSession.locator('[aria-label="Running"]')).toHaveCount(0);
        await paintFrames(page, 6);
        const samples = await stopTranscriptFrameSamples(transcript);
        expect(samples.length).toBeGreaterThan(10);
        expect(Math.max(...samples.map((sample) => sample.gap))).toBeLessThanOrEqual(1);
        return;
      }

      if (scenario === "keeps every resize frame at the bottom") {
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "transcript item 47",
        );
        await paintFrames(page, 6);
        await startTranscriptFrameSamples(transcript);
        for (const height of [700, 1100, 400]) {
          await transcript.evaluate(
            (element, height) =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => {
                  const row = Array.from(
                    element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
                  ).at(-1);
                  if (!row) throw new Error("Missing transcript row");
                  row.style.minHeight = `${height}px`;
                  resolve();
                }),
              ),
            height,
          );
          await paintFrames(page, 6);
        }
        const composer = page.getByRole("combobox", { name: "Message" });
        await composer.fill(Array.from({ length: 15 }, (_, index) => `Line ${index}`).join("\n"));
        await paintFrames(page, 6);
        await composer.fill("");
        await paintFrames(page, 6);
        const samples = await stopTranscriptFrameSamples(transcript);
        expect(samples.length).toBeGreaterThan(10);
        expect(Math.max(...samples.map((sample) => sample.gap))).toBeLessThanOrEqual(1);
        expect(samples.every((sample) => sample.anchorId !== undefined)).toBe(true);
        return;
      }

      if (scenario === "preserves the reading anchor during row resize") {
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "transcript item 47",
        );
        await transcript.hover({ position: { x: 20, y: 200 } });
        const bottomTop = await transcript.evaluate((element) => element.scrollTop);
        await page.mouse.wheel(0, -100);
        await expect
          .poll(() => transcript.evaluate((element) => element.scrollTop))
          .toBeLessThan(bottomTop - 50);
        await paintFrames(page, 6);
        const saved = await transcriptAnchor(transcript);
        await startTranscriptFrameSamples(transcript);
        for (const delta of [100, -50]) {
          await transcript.evaluate(
            (element, delta) =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => {
                  const top = element.getBoundingClientRect().top;
                  const above = Array.from(
                    element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
                  ).find((row) => row.getBoundingClientRect().bottom <= top);
                  if (!above) throw new Error("Missing overscanned row above the reading anchor");
                  above.style.minHeight = `${above.offsetHeight + delta}px`;
                  resolve();
                }),
              ),
            delta,
          );
          await paintFrames(page, 8);
        }
        const composer = page.getByRole("combobox", { name: "Message" });
        await composer.fill("Line one\nLine two\nLine three\nLine four");
        await paintFrames(page, 6);
        await composer.fill("");
        await paintFrames(page, 6);
        const samples = await stopTranscriptFrameSamples(transcript);
        expect(samples.length).toBeGreaterThan(2);
        expect(
          samples.filter(
            (sample) =>
              sample.anchorText !== saved.text || Math.abs(sample.offset! - saved.offset) > 1,
          ),
        ).toEqual([]);
        return;
      }

      if (scenario === "escapes bottom following during height measurement") {
        // Growing the last row starts bottom alignment. Reproduce the ordering
        // deterministically in one frame: upward intent, native scroll movement,
        // then another measurement before Virtuoso's old alignment retry expires.
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "transcript item 47",
        );
        await transcript.hover({ position: { x: 20, y: 200 } });
        await page.waitForTimeout(250);
        await transcript.evaluate(async (element) => {
          const lastItem = Array.from(
            element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
          ).at(-1);
          if (!lastItem) throw new Error("Missing last transcript item");
          lastItem.style.minHeight = "500px";
          await new Promise<void>((resolve) => {
            const aligned = () => {
              if (element.scrollHeight - element.clientHeight - element.scrollTop <= 1) resolve();
              else requestAnimationFrame(aligned);
            };
            requestAnimationFrame(aligned);
          });
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -800, bubbles: true }));
          element.scrollTop -= 800;
          lastItem.style.minHeight = "800px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(500);
        await page.waitForTimeout(400);
        expect(
          await transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ).toBeGreaterThan(500);

        // Check native keyboard input too, focused on an actual transcript
        // control rather than on a test-only focusable element.
        await page.mouse.wheel(0, 10_000);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        const copy = transcript.getByRole("button", { name: "Copy response", exact: true }).last();
        await copy.focus();
        await expect(copy).toBeFocused();
        await page.keyboard.press("PageUp");
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(100);
        await transcript
          .locator('[data-slot="transcript-item"]')
          .last()
          .evaluate((element) => {
            element.style.minHeight = "1000px";
          });
        await page.waitForTimeout(250);
        expect(
          await transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ).toBeGreaterThan(100);

        // Overlay scrollbars reserve no gutter, so the thumb geometry below needs
        // a deterministic native scrollbar only for this drag fixture.
        const scrollbarStyle = await page.addStyleTag({
          content: ".transcript::-webkit-scrollbar { width: 14px; }",
        });
        try {
          await expect
            .poll(() =>
              transcript.evaluate(
                (element) =>
                  element.getBoundingClientRect().width - element.clientWidth - element.clientLeft,
              ),
            )
            .toBeGreaterThan(0);
          await transcript.hover({ position: { x: 20, y: 200 } });
          await page.mouse.wheel(0, 10_000);
          await expect
            .poll(() =>
              transcript.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeLessThanOrEqual(1);
          const scrollbar = await transcript.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const gutter = rect.width - element.clientWidth - element.clientLeft;
            const thumbHeight = element.clientHeight ** 2 / element.scrollHeight;
            return { x: rect.right - gutter / 2, y: rect.bottom - thumbHeight / 2 };
          });
          await page.mouse.move(scrollbar.x, scrollbar.y);
          await page.mouse.down();
          await page.mouse.move(scrollbar.x, scrollbar.y - 180, { steps: 5 });
          await page.mouse.up();
          await expect
            .poll(() =>
              transcript.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeGreaterThan(100);
          await transcript
            .locator('[data-slot="transcript-item"]')
            .last()
            .evaluate((element) => {
              element.style.minHeight = "1200px";
            });
          await page.waitForTimeout(250);
          expect(
            await transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          ).toBeGreaterThan(100);
        } finally {
          await scrollbarStyle.evaluate((element) => element.parentNode?.removeChild(element));
        }
        return;
      }

      if (scenario === "reopens a large loaded session") {
        for (let repeat = 0; repeat < 3; repeat += 1) {
          await secondSession.locator(".session-row").click();
          await expect(secondSession).toHaveClass(/active/);
          await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
            "Second scroll fixture",
          );
          // Record every paint opportunity, not just the eventual scroll position.
          // An initially visible top/middle render followed by a bottom scroll flashes.
          await page.evaluate(() => {
            const samples: number[] = [];
            const sample = () => {
              const scroller = document.querySelector<HTMLElement>(
                '.transcript:not([data-slot="content-transition-outgoing"] *)',
              );
              const list = scroller?.querySelector<HTMLElement>('[aria-label="Conversation"]');
              if (
                scroller &&
                list &&
                getComputedStyle(list).visibility === "visible" &&
                list.textContent?.includes("First scroll fixture")
              )
                samples.push(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
              frame = requestAnimationFrame(sample);
            };
            let frame = requestAnimationFrame(sample);
            Object.assign(window, {
              finishOpeningSamples: () => {
                cancelAnimationFrame(frame);
                return samples;
              },
            });
          });
          await firstSession.locator(".session-row").click();
          await expect(firstSession).toHaveClass(/active/);
          await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
            "transcript item 479",
          );
          await expect(transcript.locator('[data-slot="transcript-item"]').last()).toBeVisible();
          // Include at least one frame after the initial positioning is revealed.
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
          );
          await expect
            .poll(() =>
              transcript.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeLessThanOrEqual(1);
          const openingSamples = await page.evaluate(() => {
            const capture = window as typeof window & { finishOpeningSamples(): number[] };
            return capture.finishOpeningSamples();
          });
          expect(openingSamples.length).toBeGreaterThan(0);
          expect(Math.max(...openingSamples)).toBeLessThanOrEqual(1);
          expect(await transcript.locator('[data-slot="transcript-item"]').count()).toBeLessThan(
            40,
          );
        }
        return;
      }

      const composer = page.getByRole("combobox", { name: "Message" });
      await composer.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
      await expect(page.locator('[data-slot="transcript-item"]').last()).toBeVisible();
      await expect
        .poll(async () => {
          const lastMessageBottom = await page
            .locator('[data-slot="transcript-item"]')
            .last()
            .evaluate((element) => element.getBoundingClientRect().bottom);
          const composerTop = await page
            .locator(".workbench-composer")
            .evaluate((element) => element.getBoundingClientRect().top);
          return Math.abs(lastMessageBottom - composerTop);
        })
        .toBeLessThanOrEqual(2);
      await composer.fill("");

      if (scenario === "follows the full bottom and isolates nested scrolling") {
        // A nested overflow surface consumes its own wheel input. It must not
        // disable transcript following when later content changes the outer height.
        await transcript.evaluate((element) => {
          const footer = element.querySelector("[data-viewport-type]")?.lastElementChild;
          if (!(footer instanceof HTMLElement)) throw new Error("Missing transcript footer");
          const nested = document.createElement("div");
          nested.dataset.testid = "nested-scroll-fixture";
          nested.style.cssText = "height: 100px; overflow: auto; overscroll-behavior: contain";
          const content = document.createElement("div");
          content.style.height = "800px";
          content.textContent = "Nested scroll fixture";
          nested.append(content);
          footer.prepend(nested);
        });
        const nested = page.getByTestId("nested-scroll-fixture");
        await expect(nested).toBeVisible();
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await nested.hover();
        await page.mouse.wheel(0, 150);
        await expect.poll(() => nested.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await page.waitForTimeout(250);
        await nested.evaluate((element) => {
          element.style.height = "200px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        // At the nested boundary, containment still prevents scroll chaining.
        await nested.evaluate((element) => {
          element.scrollTop = 0;
        });
        await nested.hover();
        await page.mouse.wheel(0, -150);
        await nested.evaluate((element) => {
          element.style.height = "250px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        // Without containment, upward input at the nested top reaches the outer
        // transcript. It must cancel following on the very first gesture.
        await nested.evaluate((element) => {
          element.style.overscrollBehavior = "auto";
        });
        await page.mouse.wheel(0, -150);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(100);
        await nested.evaluate((element) => {
          element.style.height = "300px";
        });
        await page.waitForTimeout(250);
        expect(
          await transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ).toBeGreaterThan(100);
        await transcript.hover({ position: { x: 20, y: 200 } });
        await page.mouse.wheel(0, 10_000);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await nested.evaluate((element) => element.remove());
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      }

      await page.waitForTimeout(500);
      const bottomPosition = await transcript.evaluate((element) => element.scrollTop);
      await transcript.hover();
      await page.mouse.wheel(0, -2_000);
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollTop))
        .toBeLessThan(bottomPosition - 500);
      await page.waitForTimeout(500);
      const savedAnchor = await transcriptAnchor(transcript);

      if (stream) {
        // Submitting in B must not re-enable following in A, and B's ongoing
        // provider events and completion must not disturb A's restored anchor.
        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "Second scroll fixture transcript item 47",
        );
        await page.getByRole("button", { name: "Model configuration" }).click();
        await page.getByRole("button", { name: "Change model" }).click();
        await page.getByLabel("Search presets and models").fill("Scroll fixture");
        await page
          .getByRole("button", { name: /Scroll fixture/ })
          .first()
          .click();
        await page.getByRole("button", { name: "Apply", exact: true }).click();
        await composer.click();
        await expect(composer).toBeFocused();
        await page.keyboard.type("Stream in the other session");
        await expect(composer).toHaveValue("Stream in the other session");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await page.keyboard.press("Enter");
        await expect.poll(stream.ready).toBe(true);
        stream.send("Background response started.\n\n");
        await expect(transcript).toContainText("Background response started.");
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);
        await expectRestoredAnchor(transcript, savedAnchor);
        await expect(secondSession.locator('[aria-label="Running"]')).toBeVisible();
        stream.send("Background content keeps growing.\n\n".repeat(100));
        stream.finish();
        await expect(secondSession.locator('[aria-label="Running"]')).toHaveCount(0);
        await expectRestoredAnchor(transcript, savedAnchor);
        return;
      }

      if (scenario === "restores session position") {
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
        await page.getByLabel("Back to chat").click();
        await expectRestoredAnchor(transcript, savedAnchor);

        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);

        await expectRestoredAnchor(transcript, savedAnchor);
        // Let Virtuoso finish the initial anchor measurement before testing a
        // separate programmatic move. An empty, not-yet-mounted list is also at 0.
        await page.waitForTimeout(250);

        await transcript.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await page.waitForTimeout(150);
        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);
        const firstItem = transcript.locator('[data-slot="transcript-item"]').first();
        await expect(firstItem).toHaveAttribute(
          "data-transcript-anchor-id",
          "runtime-system-prompt-system",
        );
        await expect(firstItem.getByRole("button", { name: "System", exact: true })).toBeVisible();
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
        await page.waitForTimeout(250);

        await transcript.hover({ position: { x: 20, y: 200 } });
        await page.mouse.wheel(0, 10_000);
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "First scroll fixture transcript item 47",
        );
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await page.waitForTimeout(150);
        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);
        await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
          "First scroll fixture transcript item 47",
        );
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);

        // Another session settling rerenders the application shell. Exercise the
        // same parent-render boundary after Virtuoso has restored this transcript.
        await page
          .getByRole("complementary")
          .getByRole("button", { name: "Toggle sidebar" })
          .click();
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      } else {
        // Resizing the composer while reading history must not pull us back down.
        await composer.fill("Line one\nLine two\nLine three\nLine four");
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(500);
        await composer.fill("");

        // Submission must reach the real DOM bottom from a mid-history
        // position, including the optimistic message, loading row and error footer.
        await composer.click();
        await expect(composer).toBeFocused();
        await page.keyboard.type("Scroll submission fixture");
        await expect(composer).toHaveValue("Scroll submission fixture");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await page.waitForTimeout(1500);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);

        // Exercise delayed streaming/layout growth after submission has settled.
        const lastItem = transcript.locator('[data-slot="transcript-item"]').last();
        for (const height of [400, 800, 200, 600]) {
          await lastItem.evaluate((element, height) => {
            element.style.minHeight = `${height}px`;
          }, height);
          await expect
            .poll(() =>
              transcript.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeLessThanOrEqual(1);
        }
        // A downward wheel at the outer bottom may not emit a native scroll event.
        await transcript.hover({ position: { x: 20, y: 200 } });
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(300);
        await lastItem.evaluate((element) => {
          element.style.minHeight = "900px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      }
    } finally {
      await application.close();
      await stream?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
