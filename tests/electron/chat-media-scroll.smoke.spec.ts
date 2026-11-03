import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { recordedRendererErrors, recordRendererErrors } from "../fixtures/renderer-errors";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const diagram = [
  "```mermaid",
  "flowchart TD",
  ...Array.from({ length: 12 }, (_, i) => `N${i}[Pipeline stage ${i}] --> N${i + 1}`),
  "```",
].join("\n");
const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

interface MediaProbe {
  loadingFrames: number;
  diagramFrames: number;
  imageFrames: number;
  jumps: Array<{ id: string; delta: number | "unmounted" }>;
}

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript")!;
    const result: MediaProbe = { loadingFrames: 0, diagramFrames: 0, imageFrames: 0, jumps: [] };
    type Geometry = {
      viewportTop: number;
      rows: Array<{ id: string; top: number; bottom: number }>;
      loading: boolean;
      diagram: boolean;
      image: boolean;
    };
    let pending: Geometry | undefined;
    let previous: Geometry["rows"][number] | undefined;
    let frame: number;
    let tall = false;
    const sentinel = document.createElement("div");
    sentinel.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;contain:strict;pointer-events:none";
    document.body.append(sentinel);

    // ResizeObserver runs after rAF and layout. Retain its final geometry, then
    // consume it on the next rAF, after that frame painted. A post-rAF timer can
    // instead force layout between a late React commit and its next resize
    // delivery, falsely calling geometry that never painted a reading jump.
    const commit = () => {
      const painted = pending;
      pending = undefined;
      if (!painted) return;
      if (previous) {
        const retained = painted.rows.find((row) => row.id === previous!.id);
        if (retained) {
          const delta = retained.top - previous.top;
          if (Math.abs(delta) > 181) result.jumps.push({ id: previous.id, delta });
        } else if (previous.bottom > painted.viewportTop + 181) {
          result.jumps.push({ id: previous.id, delta: "unmounted" });
        }
      }
      previous = painted.rows.find((row) => row.bottom > painted.viewportTop + 1);
      if (painted.diagram) result.diagramFrames++;
      if (painted.loading) {
        result.loadingFrames++;
        window.dispatchEvent(new Event("transcript-diagram-loading-painted"));
      }
      if (painted.image) result.imageFrames++;
    };
    const observer = new ResizeObserver(() => {
      const block = scroller.querySelector('[data-diagram="pele"]');
      pending = {
        viewportTop: scroller.getBoundingClientRect().top,
        rows: [...scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].map(
          (row) => {
            const rect = row.getBoundingClientRect();
            return { id: row.dataset.transcriptAnchorId!, top: rect.top, bottom: rect.bottom };
          },
        ),
        loading: Boolean(block && !block.querySelector("svg.pele")),
        diagram: Boolean(block?.querySelector("svg.pele")),
        image: [...scroller.querySelectorAll("img")].some(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      };
    });
    observer.observe(sentinel);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    const tick = () => {
      commit();
      tall = !tall;
      sentinel.style.height = tall ? "2px" : "1px";
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    Reflect.set(
      window,
      "stopMediaProbe",
      () =>
        new Promise<MediaProbe>((resolve) =>
          requestAnimationFrame(() => {
            commit();
            cancelAnimationFrame(frame);
            observer.disconnect();
            sentinel.remove();
            resolve(result);
          }),
        ),
    );
  });
}

for (const media of ["diagram", "image", "combined"] as const) {
  test(`manual scrolling across ${media} media preserves the painted reading position`, async () => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-media-scroll-"));
    const project = join(directory, "project");
    const userData = join(directory, "user-data");
    const cakeHome = join(directory, "cake-home");
    const sessionId = "media-scroll";
    const timestamp = new Date(0).toISOString();
    const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
    await Promise.all([
      mkdir(project),
      mkdir(userData),
      mkdir(sessions, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId, theme: "light" }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      }),
    );
    const entries: unknown[] = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
    ];
    for (let index = 0; index < 48; index++) {
      const role = index % 2 ? "assistant" : "user";
      const content: unknown[] = [
        {
          type: "text",
          text:
            index === 23 && media !== "image"
              ? diagram
              : `Message ${index}. ${"Reading context. ".repeat(20)}`,
        },
      ];
      if (index === 22 && media !== "diagram")
        content.push({ type: "image", mimeType: "image/png", data: imageData });
      entries.push({
        type: "message",
        id: `message-${index}`,
        parentId: index ? `message-${index - 1}` : null,
        timestamp,
        message:
          role === "user"
            ? { role, content, timestamp: index }
            : {
                role,
                content,
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
    }
    await writeFile(
      join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const transcript = page.locator(".transcript").first();
      await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
        "Message 47",
        { timeout: 20_000 },
      );
      await expect(transcript.locator('[aria-label="Conversation"]')).toBeVisible();
      // Async row growth must not re-render inside ResizeObserver delivery.
      await recordRendererErrors(page);
      // Gate only worker transport on a painted loading sample, not elapsed
      // time. Pele, native layout and measurement remain real, and every
      // traversal must still cover both loading and loaded diagrams.
      await page.evaluate(() => {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            if (options?.name === "cake-diagram") {
              const postMessage = this.postMessage.bind(this);
              this.postMessage = (message: unknown) => {
                window.addEventListener(
                  "transcript-diagram-loading-painted",
                  () => postMessage(message),
                  { once: true },
                );
              };
            }
          }
        };
      });
      await transcript.hover({ position: { x: 30, y: 250 } });
      for (const direction of [-1, 1, -1, 1]) {
        await startProbe(page);
        let reachedEnd = false;
        for (let step = 0; step < 90; step++) {
          await page.mouse.wheel(0, direction * 180);
          // Allow the native wheel and following painted frame to settle before
          // the next step; the probe still checks every intermediate frame.
          await page.waitForTimeout(60);
          reachedEnd = await transcript.evaluate(
            (element, direction) =>
              direction < 0
                ? element.scrollTop <= 1
                : element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
            direction,
          );
          if (reachedEnd) break;
        }
        const result = await page.evaluate(() =>
          (Reflect.get(window, "stopMediaProbe") as () => Promise<MediaProbe>)(),
        );
        expect(
          await recordedRendererErrors(page),
          `renderer errors scrolling ${direction < 0 ? "up" : "down"}`,
        ).toEqual([]);
        expect(result.jumps, `painted jumps scrolling ${direction < 0 ? "up" : "down"}`).toEqual(
          [],
        );
        expect(reachedEnd, "manual scrolling must make progress past the media").toBe(true);
        if (media !== "image") {
          expect(result.loadingFrames).toBeGreaterThan(0);
          expect(result.diagramFrames).toBeGreaterThan(0);
        }
        if (media !== "diagram") expect(result.imageFrames).toBeGreaterThan(0);
      }
      if (media === "combined") {
        // A probe that ignores real painted movement would manufacture green.
        // Inject a visible transform after the traversal and require its 400px jump.
        const painted = () =>
          page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() => requestAnimationFrame(() => done())),
              ),
          );
        await startProbe(page);
        await painted();
        await transcript.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = [
            ...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]"),
          ].find((item) => item.getBoundingClientRect().bottom > top + 1)!;
          row.dataset.probeTarget = "true";
          row.style.transform = "translateY(400px)";
        });
        await painted();
        const control = await page.evaluate(() =>
          (Reflect.get(window, "stopMediaProbe") as () => Promise<MediaProbe>)(),
        );
        expect(control.jumps.some((jump) => jump.delta === 400)).toBe(true);
        await transcript.locator('[data-probe-target="true"]').evaluate((row) => {
          row.style.removeProperty("transform");
          delete row.dataset.probeTarget;
        });
      }
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
