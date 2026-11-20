import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import type { TranscriptOwnershipFixture } from "./transcript-ownership-fixture";
import type { UiPart } from "../../src/contracts/conversations/session-contract";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";
import type { CompiledInlineWidget } from "../../src/contracts/widgets/inline-widget-contract";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { recordedRendererErrors, recordRendererErrors } from "../fixtures/renderer-errors";
import { windowState } from "../fixtures/window-state";
import {
  fixtureModelChange,
  startFixtureModelServer,
  writeFixtureModels,
} from "./fixtures/fixture-model";
import { openSession, showSessions } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const capture = process.env.CAKE_TRANSCRIPT_CAPTURE === "1";
const captureDirectory = join(repositoryRoot, ".visual-captures/transcript-follow");
const test = base.extend<{
  fixturePage: Page;
  messageCount: number;
  chatMode: string;
  withWidget: boolean;
  withUpdates: boolean;
  withImages: boolean;
  withHistory: boolean;
}>({
  withHistory: [false, { option: true }],
  withImages: [false, { option: true }],
  withUpdates: [false, { option: true }],
  withWidget: [false, { option: true }],
  messageCount: [48, { option: true }],
  chatMode: ["full", { option: true }],
  fixturePage: async (
    { messageCount, chatMode, withWidget, withUpdates, withImages, withHistory },
    use,
  ) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-transcript-follow-"));
    const cakeHome = join(temporaryRoot, "cake-home");
    await mkdir(cakeHome);
    await build({
      entryPoints: [join(import.meta.dirname, "transcript-ownership-fixture.tsx")],
      outfile: join(temporaryRoot, "fixture.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      target: "es2022",
      loader: { ".css": "empty", ".svg": "text", ".png": "dataurl" },
      plugins: [
        {
          name: "asset-urls",
          setup(builder) {
            // This isolated fixture does not run Vite's dev-only inspector plugin.
            builder.onResolve({ filter: /^virtual:r-state-tree-inspector$/ }, () => ({
              path: "inspector",
              namespace: "fixture-inspector",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture-inspector" }, () => ({
              contents: "export const token = undefined;",
              loader: "js",
            }));
            builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({
              path,
              namespace: "asset-url",
            }));
            builder.onLoad({ filter: /.*/, namespace: "asset-url" }, ({ path }) => ({
              contents: `export default ${JSON.stringify(path)}`,
              loader: "js",
            }));
          },
        },
      ],
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    });
    const assets = join(repositoryRoot, "out/renderer/assets");
    const css = (await readdir(assets)).find(
      (name) => name.startsWith("index-") && name.endsWith(".css"),
    )!;
    const html = join(temporaryRoot, "fixture.html");
    await writeFile(
      html,
      `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css))}"></head><body><div id="root" style="height:600px"></div><script type="module" src="./fixture.js"></script></body></html>`,
    );
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
      // Opt-in evidence recording for reviews: CAKE_TRANSCRIPT_CAPTURE=1.
      ...(capture
        ? { recordVideo: { dir: captureDirectory, size: { width: 900, height: 700 } } }
        : {}),
    });
    try {
      await application.firstWindow();
      const widget = withWidget
        ? (
            await callRpcHarness<{ widget: CompiledInlineWidget }>(
              await openRpcHarness(application, "scroll-widget"),
              "invokeNative",
              {
                type: "compile-inline-widget",
                language: "react",
                capability: "artifact",
                source: `import { useArtifactState } from "@cake/artifact-sdk";
export default function Widget() {
  const { hydrated, value } = useArtifactState({ title: "seed" });
  return <main style={{height:"100%",background:"var(--background)",color:"var(--foreground)"}}><h1>{hydrated ? value.title : "Hydrating widget"}</h1><button onClick={e => e.currentTarget.textContent = "Local state retained"}>Widget interaction</button></main>;
}`,
              },
            )
          ).widget
        : null;
      await application.context().route("https://transcript.invalid/**", (route) => {
        const index = Number(new URL(route.request().url()).pathname.slice(1));
        return route.fulfill({
          contentType: "image/svg+xml",
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${200 + (index % 7) * 150}"/>`,
        });
      });
      const errors: string[] = [];
      application.context().on("page", (page) => {
        page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
      });
      const opened = application.waitForEvent("window");
      await application.evaluate(
        async (
          { BrowserWindow },
          { html, messageCount, chatMode, widget, withUpdates, withImages, withHistory },
        ) => {
          // Match the application window: a hidden window must not throttle
          // animation frames, or the list never finishes its initial placement.
          const window = new BrowserWindow({
            show: false,
            webPreferences: { sandbox: true, backgroundThrottling: false },
          });
          await window.loadFile(html, {
            search: `?count=${messageCount}&chatMode=${chatMode}&updates=${withUpdates}&images=${withImages}&history=${withHistory}&widget=${encodeURIComponent(JSON.stringify(widget))}`,
          });
        },
        { html, messageCount, chatMode, widget, withUpdates, withImages, withHistory },
      );
      const page = await opened;
      const transcript =
        chatMode === "annotation"
          ? page.getByRole("region", { name: "Main pane" }).locator(".transcript")
          : page.locator(".transcript");
      await expect(
        transcript.getByText(
          chatMode === "annotation"
            ? "Shared guidance for this review."
            : withUpdates
              ? "Make widgets follow Cake theme live"
              : `Message ${messageCount - 1}.`,
        ),
      ).toBeVisible();
      // The list stays transparent until its initial placement settles.
      await expect
        .poll(() =>
          transcript.evaluate(
            (element) =>
              getComputedStyle(
                element.querySelector("[data-transcript-item-key]")!.parentElement!.parentElement!,
              ).opacity,
          ),
        )
        .toBe("1");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await use(page);
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
});

type Fixture = TranscriptOwnershipFixture;
const fixtureCall = <Name extends keyof Fixture>(
  page: Page,
  name: Name,
  ...args: Parameters<Fixture[Name]>
) =>
  page.evaluate(
    ([name, args]) =>
      // SAFETY: the fixture page installs this object before the test starts.
      (
        Reflect.get(window, "transcriptFixture") as Record<
          string,
          (...values: unknown[]) => unknown
        >
      )[name]!(...args),
    [name, args] as const,
  );
const gap = (transcript: Locator) =>
  transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

/** The first row visible at the top of the viewport and its on-screen offset (rows are absolutely placed). */
const anchor = (transcript: Locator) =>
  transcript.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")]
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > top + 1)
      .sort((a, b) => a.rect.top - b.rect.top);
    const first = rows[0]!;
    return {
      id: first.row.dataset.transcriptAnchorId,
      offset: Math.round(first.rect.top - top),
    };
  });

async function withoutScrollbarReveal<Result>(page: Page, run: () => Promise<Result>) {
  await expect(page.locator(".transcript[data-scrollbar-visible]")).toHaveCount(0);
  await page.evaluate(() => {
    let revealed = false;
    const changes = new MutationObserver((records) => {
      revealed ||= records.some((record) => record.oldValue === null);
    });
    changes.observe(document.body, {
      subtree: true,
      attributeFilter: ["data-scrollbar-visible"],
      attributeOldValue: true,
    });
    Reflect.set(window, "stopWatchingScrollbar", () => {
      changes.disconnect();
      return revealed;
    });
  });
  const result = await run();
  expect(await page.evaluate(() => Reflect.get(window, "stopWatchingScrollbar")())).toBe(false);
  return result;
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

async function wheel(page: Page, transcript: Locator, delta: number) {
  await transcript.hover({ position: { x: 40, y: 200 } });
  await page.mouse.wheel(0, delta);
  await settle(page);
  await page.waitForTimeout(150);
  await settle(page);
}

/**
 * Samples what the reader sees in each painted frame. A ResizeObserver delivers after
 * layout, after the list's own corrections, and can deliver several rounds per frame;
 * the last sample of a frame is the painted one. Sampling in requestAnimationFrame
 * would see layout the list has not corrected yet.
 */
async function samplePaintedFrames<Sample>(
  page: Page,
  kind: "anchor" | "gap",
  run: () => Promise<void>,
): Promise<[frame: number, sample: Sample][]> {
  await page.evaluate((kind) => {
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    const frames = new Map<number, unknown>();
    let frame = 0;
    const nextFrame = () => {
      frame++;
      Reflect.set(window, "paintedFrame", requestAnimationFrame(nextFrame));
    };
    nextFrame();
    // Scroll events run before the frame's animation callbacks: they belong to the next frame.
    const sample = (next = 0) => {
      if (kind === "gap") {
        // Visible distance from the end: where the content's last element sits below
        // the viewport. Scroll height alone can include the list's temporary padding.
        const footer = transcript.querySelector('[data-slot="transcript-footer"]')!;
        frames.set(
          frame + next,
          footer.getBoundingClientRect().bottom - transcript.getBoundingClientRect().bottom,
        );
        return;
      }
      const top = transcript.getBoundingClientRect().top;
      const first = [...transcript.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")]
        .map((row) => ({ row, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && rect.bottom > top + 1)
        .sort((a, b) => a.rect.top - b.rect.top)[0];
      if (first)
        frames.set(
          frame + next,
          `${first.row.dataset.transcriptAnchorId}@${Math.round(first.rect.top - top)}`,
        );
    };
    const observer = new ResizeObserver(() => queueMicrotask(() => sample()));
    const observeAll = () => {
      observer.observe(transcript);
      for (const element of transcript.querySelectorAll("*")) observer.observe(element);
    };
    observeAll();
    const mutations = new MutationObserver(observeAll);
    mutations.observe(transcript, { childList: true, subtree: true });
    const sampleScroll = () => sample(1);
    transcript.addEventListener("scroll", sampleScroll);
    Reflect.set(window, "paintedSamples", { frames, observer, mutations, sample, sampleScroll });
  }, kind);
  await run();
  return page.evaluate(() => {
    const state = Reflect.get(window, "paintedSamples") as {
      frames: Map<number, unknown>;
      observer: ResizeObserver;
      mutations: MutationObserver;
      sample(): void;
      sampleScroll(): void;
    };
    state.observer.disconnect();
    state.mutations.disconnect();
    document.querySelector(".transcript")!.removeEventListener("scroll", state.sampleScroll);
    cancelAnimationFrame(Reflect.get(window, "paintedFrame") as number);
    state.sample();
    return [...state.frames.entries()];
  }) as Promise<[number, Sample][]>;
}
const anchorEveryFrame = async (page: Page, run: () => Promise<void>) => [
  ...new Set((await samplePaintedFrames<string>(page, "anchor", run)).map(([, anchor]) => anchor)),
];
/**
 * The longest run of consecutive painted frames short of the end, and the final
 * distance. Frame attribution of a sample can be off by one around scroll events.
 */
async function pinnedFrames(page: Page, run: () => Promise<void>) {
  const samples = await samplePaintedFrames<number>(page, "gap", run);
  let longest = 0;
  let run_ = 0;
  let previous = -1;
  for (const [frame, gap] of samples) {
    run_ = gap >= 1 ? (frame === previous + 1 ? run_ : 0) + 1 : 0;
    longest = Math.max(longest, run_);
    previous = gap >= 1 ? frame : -1;
  }
  const short = samples.filter(([, gap]) => gap >= 1);
  if (short.length) console.log("Frames short of the end:", samples.length, JSON.stringify(short));
  return { longestShortRun: longest, final: samples.at(-1)![1] };
}

const streamFor = async (page: Page, milliseconds: number, mode = "text+tool+arrive") => {
  await fixtureCall(page, "startLive", 16, mode);
  await page.waitForTimeout(milliseconds);
  await fixtureCall(page, "stopLive");
  await settle(page);
};

test.describe("transcript follow rules", () => {
  test("rule 1: only accepted composer Enter forces the bottom; other sends preserve the reader", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await wheel(page, transcript, -1400);
    const reading = await anchor(transcript);
    for (const operation of ["stream", "arrive", "activity", "update"] as const) {
      await fixtureCall(page, operation);
      await settle(page);
      expect(await anchor(transcript)).toEqual(reading);
    }
    expect(await gap(transcript)).toBeGreaterThan(400);

    // Neither a button nor a programmatic send carries keyboard provenance.
    for (const method of ["button", "programmatic"]) {
      const text = `Keep my place (${method}).`;
      if (method === "button") {
        await input.fill(text);
        await page.getByRole("button", { name: "Send", exact: true }).click();
      } else await fixtureCall(page, "submitProgrammatically", text);
      await expect.poll(() => fixtureCall(page, "submittedText")).toBe(text);
      await expect(input).toHaveValue("");
      await settle(page);
      expect(await anchor(transcript)).toEqual(reading);
      expect(await gap(transcript)).toBeGreaterThan(400);
    }

    // The jump-to-bottom control remains explicit.
    const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    await expect(jump).toHaveCount(0);
    await expect(transcript.getByText("Keep my place (programmatic).")).toBeVisible();

    // Sending while already at the bottom keeps normal following.
    await input.fill("Keep following.");
    await input.press("Enter");
    await expect.poll(() => fixtureCall(page, "submittedText")).toBe("Keep following.");
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    await fixtureCall(page, "stream");
    await settle(page);
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);

    // And arrowing past the newest message.
    await wheel(page, transcript, -2400);
    await input.focus();
    await input.press("ArrowUp");
    await expect(transcript.locator('[aria-current="true"]')).toHaveCount(1);
    await fixtureCall(page, "arrive");
    await settle(page);
    expect(await gap(transcript)).toBeGreaterThan(1);
    // Walk down past the newest message (the arrival is a stop too).
    for (
      let step = 0;
      step < 4 && (await transcript.locator('[aria-current="true"]').count());
      step++
    )
      await page.keyboard.press("ArrowDown");
    await expect(transcript.locator('[aria-current="true"]')).toHaveCount(0);
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
  });

  test("writing clears keyboard selection and accepted Enter goes to the bottom", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await input.focus();
    for (let step = 0; step < 5; step++) await input.press("ArrowUp");
    const selected = transcript.locator('[aria-current="true"]');
    await expect(selected).toHaveCount(1);
    await input.fill("Send without moving the reading position.");
    // Writing intentionally ends keyboard message selection, not the reading position.
    await expect(selected).toHaveCount(0);
    await settle(page);
    await input.press("Enter");
    await expect
      .poll(() => fixtureCall(page, "submittedText"))
      .toBe("Send without moving the reading position.");
    await expect.poll(() => gap(transcript)).toBeLessThan(1);
    await expect(selected).toHaveCount(0);
  });

  test("Cmd+Down uses the focused chat's arrow but preserves composer caret navigation", async ({
    fixturePage: page,
  }) => {
    test.skip(process.platform !== "darwin", "Mac default binding.");
    const transcript = page.locator(".transcript");
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await wheel(page, transcript, -1600);
    const reading = await anchor(transcript);
    await input.fill("First line.\\nSecond line.");
    await input.press("Home");
    await input.press("Meta+ArrowDown");
    await settle(page);
    expect(await anchor(transcript)).toEqual(reading);
    expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
      "First line.\\nSecond line.".length,
    );

    await input.fill("");
    const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    await jump.hover();
    await expect(page.getByRole("tooltip")).toContainText("⌘↓");
    await input.press("Meta+ArrowDown");
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    await expect(jump).toHaveCount(0);
    await fixtureCall(page, "stream");
    await settle(page);
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
  });

  for (const delta of [-1, -4, -40]) {
    test(`rule 2: a ${-delta}px upward scroll while streaming ends following`, async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      await fixtureCall(page, "startLive", 16, "text");
      await page.waitForTimeout(300);
      await transcript.hover({ position: { x: 40, y: 200 } });
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(200);
      const reading = await anchor(transcript);
      const samples = await anchorEveryFrame(page, () => page.waitForTimeout(1200));
      await fixtureCall(page, "stopLive");
      expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
      expect(await gap(transcript)).toBeGreaterThan(100);
    });
  }

  test("rule 3: while not following, nothing moves the visible content", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await wheel(page, transcript, -1600);
    const reading = await anchor(transcript);
    const samples = await withoutScrollbarReveal(page, () =>
      anchorEveryFrame(page, async () => {
        await streamFor(page, 1500);
        for (const operation of ["stream", "arrive", "activity", "insertBelow"] as const) {
          if (operation === "insertBelow") await fixtureCall(page, "arrive");
          else await fixtureCall(page, operation);
          await settle(page);
        }
        // A message above the viewport grows (a tool card expanding, an image loading).
        await fixtureCall(page, "grow", "message-2");
        await settle(page);
        await page.waitForTimeout(300);
      }),
    );
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
  });

  test("rule 4: arrow-key selection is not disturbed by streaming or arriving messages", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await input.focus();
    for (let step = 0; step < 3; step++) await input.press("ArrowUp");
    const selected = transcript.locator('[aria-current="true"]');
    await expect(selected).toHaveCount(1);
    const id = await selected.getAttribute("data-transcript-anchor-id");
    await settle(page);
    const position = () => selected.evaluate((row) => Math.round(row.getBoundingClientRect().top));
    const before = await position();
    const samples = await anchorEveryFrame(page, () => streamFor(page, 1500));
    expect(samples).toHaveLength(1);
    await expect(selected).toHaveAttribute("data-transcript-anchor-id", id!);
    expect(await position()).toBe(before);
    // Moving the selection still works and stays on the reader's message order.
    await page.keyboard.press("ArrowUp");
    await expect(selected).not.toHaveAttribute("data-transcript-anchor-id", id!);
  });

  test("rule 5: at the bottom, streaming output stays pinned", async ({ fixturePage: page }) => {
    const transcript = page.locator(".transcript");
    expect(await gap(transcript)).toBeLessThanOrEqual(1);
    const frames = await withoutScrollbarReveal(page, () =>
      pinnedFrames(page, () => streamFor(page, 2000)),
    );
    // The list places a newly added row, then pins the end on the next frame.
    expect(frames.longestShortRun).toBe(0);
    expect(frames.final).toBeLessThan(1);
  });

  test("rule 6: returning to the bottom by scrolling or the control resumes following", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await wheel(page, transcript, -1200);
    await fixtureCall(page, "arrive");
    await settle(page);
    expect(await gap(transcript)).toBeGreaterThan(1);
    // Scroll back down to the end by hand.
    await wheel(page, transcript, 20_000);
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    expect(
      (await pinnedFrames(page, () => streamFor(page, 1200))).longestShortRun,
    ).toBeLessThanOrEqual(2);

    await wheel(page, transcript, -2400);
    await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    expect(
      (await pinnedFrames(page, () => streamFor(page, 1200))).longestShortRun,
    ).toBeLessThanOrEqual(2);
  });
});

test.describe("expanding while following", () => {
  test("rule 5: opening a streaming Work log keeps following, with its summary in view", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await fixtureCall(page, "startLive", 40, "tool");
    const log = transcript.locator('[data-slot="activity-group"]');
    const summary = log.locator(":scope > summary");
    await expect(summary).toBeVisible();
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    // A bounded Work log scrolls inside itself, so following never hides what was opened.
    await summary.click();
    await expect(log).toHaveAttribute("open", "");
    await page.waitForTimeout(800);
    await settle(page);
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    await expect(summary).toBeInViewport();
    await fixtureCall(page, "stopLive");
  });
});

test.describe("more reader input", () => {
  test("rule 2: PageUp and touch scrolling end following too", async ({ fixturePage: page }) => {
    const transcript = page.locator(".transcript");
    await fixtureCall(page, "startLive", 16, "text");
    await page.waitForTimeout(200);
    await transcript.focus();
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(300);
    const reading = await anchor(transcript);
    const samples = await anchorEveryFrame(page, () => page.waitForTimeout(800));
    await fixtureCall(page, "stopLive");
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);

    await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
    await expect.poll(() => gap(transcript)).toBeLessThan(1);
    await fixtureCall(page, "startLive", 16, "text");
    // A finger moving down scrolls the content up.
    const box = (await transcript.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    const point = (y: number) => [{ x: box.x + 60, y }];
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(box.y + 200),
    });
    for (let step = 1; step <= 6; step++)
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(box.y + 200 + step * 10),
      });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(400);
    const touched = await anchor(transcript);
    const touchSamples = await anchorEveryFrame(page, () => page.waitForTimeout(800));
    await fixtureCall(page, "stopLive");
    expect(touchSamples).toEqual([`${touched.id}@${touched.offset}`]);
  });
});

test.describe("earlier history", () => {
  test.use({ withHistory: true });
  test("rule 3: a prepended page never moves the reader", async ({ fixturePage: page }) => {
    const transcript = page.locator(".transcript");
    const requests = () => fixtureCall(page, "historyRequests") as Promise<string[]>;
    expect(await requests()).toEqual([]);
    await wheel(page, transcript, -20_000);
    await expect.poll(requests).toEqual(["1"]);
    await wheel(page, transcript, 300);
    const reading = await anchor(transcript);
    const samples = await anchorEveryFrame(page, async () => {
      await fixtureCall(page, "stream");
      await fixtureCall(page, "releaseHistory");
      await expect(transcript.getByText("Older page 1 message 63.")).toBeAttached();
      await settle(page);
      await page.waitForTimeout(300);
    });
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
    // Layout alone never pages; only the reader's next approach does.
    expect(await requests()).toEqual(["1"]);
  });
});

test.describe("embedded widget frame", () => {
  test.use({ withWidget: true });
  test("rule 2: an upward gesture over a widget frame ends following", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const iframe = transcript.locator("iframe");
    await expect(transcript.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
    const bounds = (await iframe.boundingBox())!;
    const viewport = (await transcript.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, Math.max(viewport.y, bounds.y) + 30);
    await fixtureCall(page, "startLive", 16, "text");
    await page.waitForTimeout(300);
    expect(await gap(transcript)).toBeLessThan(1);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(300);
    const reading = await anchor(transcript);
    const samples = await anchorEveryFrame(page, () => page.waitForTimeout(800));
    await fixtureCall(page, "stopLive");
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
    expect(await gap(transcript)).toBeGreaterThan(39);
  });
});

test.describe("image-heavy transcript", () => {
  test.use({ withImages: true, messageCount: 40 });
  test("rule 3: late images never move the reader", async ({ fixturePage: page }) => {
    const transcript = page.locator(".transcript");
    // Scroll far up into rows whose images have not loaded yet.
    await wheel(page, transcript, -6000);
    await page.waitForTimeout(500);
    await settle(page);
    const reading = await anchor(transcript);
    const samples = await anchorEveryFrame(page, async () => {
      await page.waitForTimeout(1500);
      await streamFor(page, 800);
    });
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
  });
});

test.describe("compact transcript (quick chat and embedded surfaces)", () => {
  test.use({ chatMode: "compact" });
  test("rules 2, 3 and 5 hold in the compact layout", async ({ fixturePage: page }) => {
    const transcript = page.locator(".transcript");
    expect(
      (await pinnedFrames(page, () => streamFor(page, 1000))).longestShortRun,
    ).toBeLessThanOrEqual(2);
    await wheel(page, transcript, -3);
    const reading = await anchor(transcript);
    const samples = await anchorEveryFrame(page, () => streamFor(page, 1000));
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
  });
});

test.describe("Project Chat transcript", () => {
  test.use({ chatMode: "project" });
  test("rules 2, 3 and 5 hold in a Project Chat", async ({ fixturePage: page }) => {
    const transcript = page.locator(".transcript");
    expect(
      (await pinnedFrames(page, () => streamFor(page, 1000))).longestShortRun,
    ).toBeLessThanOrEqual(2);
    await wheel(page, transcript, -2);
    const reading = await anchor(transcript);
    const samples = await anchorEveryFrame(page, () => streamFor(page, 1000));
    expect(samples).toEqual([`${reading.id}@${reading.offset}`]);
  });
});

for (const scenario of [
  { title: "normal", chatMode: "full", messageCount: 48, withImages: false },
  { title: "far virtualized", chatMode: "full", messageCount: 180, withImages: false },
  { title: "compact", chatMode: "compact", messageCount: 8, withImages: false },
  { title: "Project Chat with images", chatMode: "project", messageCount: 40, withImages: true },
]) {
  test.describe(`composer Enter scroll: ${scenario.title}`, () => {
    test.use(scenario);
    test("repeated accepted Enter submissions settle at actual bottom after draft and dock layout", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const input = page.locator('[data-slot="composer-input"] [role="combobox"]');
      const measurements: unknown[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        await wheel(page, transcript, -5000);
        expect(await gap(transcript)).toBeGreaterThan(100);
        await input.focus();
        await page.keyboard.type(
          `Attempt ${attempt}. ${"Long draft changes composer height. ".repeat(25)}`,
        );
        await expect(input).toBeFocused();
        await expect(input).not.toHaveValue("");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await fixtureCall(page, "delaySubmission");
        if (attempt === 1) await fixtureCall(page, "queueNextSubmission");
        const before = await gap(transcript);
        await input.press("Enter");
        // Locally accepted input is revealed before asynchronous delivery (ab343b86).
        await expect.poll(() => gap(transcript)).toBeLessThan(1);
        await fixtureCall(page, "setDockHeight", 100 + attempt * 40);
        await fixtureCall(page, "admitSubmission");
        await expect(input).toHaveValue("");
        await expect.poll(() => gap(transcript)).toBeLessThan(1);
        // Late dock/list/viewport layouts belong to normal following after acceptance.
        await fixtureCall(page, "setDockHeight", 10);
        await page.setViewportSize({ width: 780 + attempt * 37, height: 650 });
        await fixtureCall(page, "arrive");
        await settle(page);
        await expect.poll(() => gap(transcript)).toBeLessThan(1);
        const footerGap = await transcript
          .locator('[data-slot="transcript-footer"]')
          .evaluate(
            (element) =>
              element.getBoundingClientRect().bottom -
              element.closest(".transcript")!.getBoundingClientRect().bottom,
          );
        expect(footerGap).toBeLessThan(1);
        measurements.push({
          footerGap,
          attempt,
          before,
          after: await transcript.evaluate((element) => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            viewport: element.clientHeight,
            gap: element.scrollHeight - element.clientHeight - element.scrollTop,
          })),
        });
        // A single upward gesture releases following; no lingering Enter pin.
        await wheel(page, transcript, -300);
        const released = await anchor(transcript);
        for (const operation of ["insert", "stream", "arrive", "activity", "update"] as const)
          await fixtureCall(page, operation);
        await settle(page);
        expect(await anchor(transcript)).toEqual(released);
      }
      const evidenceDirectory = join(repositoryRoot, ".visual-captures/composer-enter-scroll");
      await mkdir(evidenceDirectory, { recursive: true });
      const evidence = join(
        evidenceDirectory,
        `${scenario.chatMode}-${scenario.messageCount}-measurements.json`,
      );
      await writeFile(evidence, JSON.stringify(measurements, null, 2));
      await test.info().attach("scroll-measurements.json", {
        path: evidence,
        contentType: "application/json",
      });
    });
  });
}

test.describe("short transcript boundary", () => {
  test.use({ messageCount: 1 });
  test("Enter stays at the end when a short transcript becomes scrollable", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await input.fill("A newly long user message. ".repeat(140));
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect.poll(() => gap(transcript)).toBeLessThan(1);
    expect(await transcript.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
      await transcript.evaluate((element) => element.clientHeight),
    );
  });
});

test("slash completion and successful application commands never synthesize user-submit scrolling", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  const input = page.getByRole("combobox", { name: "Message", exact: true });
  await wheel(page, transcript, -2500);
  const reading = await anchor(transcript);
  await input.fill("/na");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  expect(await fixtureCall(page, "submittedText")).toBeUndefined();
  await input.press("Shift+Enter");
  expect(await fixtureCall(page, "submittedText")).toBeUndefined();
  await input.fill("/na");
  await input.press("Tab");
  await expect(input).toHaveValue("/name ");
  await page.keyboard.type("Renamed fixture");
  await expect(input).toHaveValue("/name Renamed fixture");
  await input.press("Escape");
  await input.press("Enter");
  await expect.poll(() => fixtureCall(page, "renamedTitle")).toBe("Renamed fixture");
  await expect(input).toHaveValue("");
  await settle(page);
  expect(await anchor(transcript)).toEqual(reading);
  expect(await fixtureCall(page, "submittedText")).toBeUndefined();
});

test("reference-chip composer Enter retains its keyboard provenance", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  await wheel(page, transcript, -3000);
  const input = page.getByRole("combobox", { name: "Message", exact: true });
  const message = "[Session](cake://session/ownership) Please continue here.";
  await input.fill(message);
  await expect(input).toHaveAttribute("contenteditable", "true");
  await input.focus();
  await expect(input).toBeFocused();
  await input.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type(" More.");
  await expect
    .poll(() => input.evaluate((element) => Reflect.get(element, "value")))
    .toBe(message + " More.");
  await input.press("Enter");
  await expect.poll(() => fixtureCall(page, "submittedText")).toBe(message + " More.");
  await expect.poll(() => gap(transcript)).toBeLessThan(1);
});

test("non-submit Enter, failed admission and conversation switches never leak force-bottom", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  const input = page.getByRole("combobox", { name: "Message", exact: true });
  await wheel(page, transcript, -3000);
  const reading = await anchor(transcript);
  await input.focus();
  await input.press("Enter");
  await input.fill("Unfinished message");
  await input.press("Shift+Enter");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await transcript.focus();
  await transcript.press("Enter");
  await settle(page);
  expect(await anchor(transcript)).toEqual(reading);
  expect(await fixtureCall(page, "submittedText")).toBeUndefined();

  // A locally consumed submission is revealed once, even if delivery then fails (ab343b86);
  // its Enter intent must not be reused afterwards.
  await fixtureCall(page, "rejectNextSubmission");
  await input.fill("Rejected message");
  await input.press("Enter");
  await expect(page.getByText("Fixture admission rejected", { exact: true })).toBeAttached();
  await expect.poll(() => gap(transcript)).toBeLessThan(1);
  await wheel(page, transcript, -3000);
  const afterRejection = await anchor(transcript);
  await fixtureCall(page, "arrive");
  await settle(page);
  expect(await anchor(transcript)).toEqual(afterRejection);

  await fixtureCall(page, "delaySubmission");
  await input.fill("Accepted after switching away");
  await input.press("Enter");
  await expect.poll(() => fixtureCall(page, "submittedText")).toBe("Accepted after switching away");
  await expect.poll(() => gap(transcript)).toBeLessThan(1);
  // Reading elsewhere before admission: the later admission must not force the bottom again.
  await wheel(page, transcript, -3000);
  const beforeSwitch = await anchor(transcript);
  await fixtureCall(page, "switchConversation");
  await fixtureCall(page, "admitSubmission");
  await settle(page);
  await expect(transcript.getByText("Accepted after switching away")).toHaveCount(0);
  await fixtureCall(page, "switchConversation");
  await settle(page);
  await expect.poll(() => anchor(transcript)).toEqual(beforeSwitch);
  await fixtureCall(page, "arrive");
  await settle(page);
  expect(await anchor(transcript)).toEqual(beforeSwitch);
});

test("reopening a conversation restores the reader's position", async ({ fixturePage: page }) => {
  const transcript = page.locator(".transcript");
  await wheel(page, transcript, -1500);
  const reading = await anchor(transcript);
  await withoutScrollbarReveal(page, async () => {
    await fixtureCall(page, "switchConversation");
    await fixtureCall(page, "switchConversation");
    await settle(page);
    await expect.poll(() => anchor(transcript)).toEqual(reading);
  });
});

const annotationProse = "Shared guidance for this review.";

async function rightClickSelection(selection: Locator, target = selection) {
  await selection.scrollIntoViewIfNeeded();
  await selection.evaluate((element) => {
    const browser = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    browser.removeAllRanges();
    browser.addRange(range);
  });
  return target.evaluate((element) =>
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
}

test.describe("transcript annotation ownership", () => {
  test.use({ chatMode: "annotation" });

  test("only the selected pane claims matching IDs, including in the fullscreen portal", async ({
    fixturePage: page,
  }, testInfo) => {
    const main = page.getByRole("region", { name: "Main pane" });
    const other = page.getByRole("region", { name: "Concurrent pane" });
    const mainProse = main.getByText(annotationProse, { exact: true });
    const otherProse = other.getByText(annotationProse, { exact: true });
    await expect(main.locator('[data-part-id="matching-id"]')).toHaveCount(1);
    await expect(other.locator('[data-part-id="matching-id"]')).toHaveCount(1);
    // true means the browser event was not canceled: keep ordinary context menus.
    expect(await rightClickSelection(mainProse, otherProse)).toBe(true);
    const otherNode = await otherProse.elementHandle();
    expect(
      await mainProse.evaluate((element, end) => {
        const range = document.createRange();
        range.setStart(element, 0);
        range.setEnd(end, end.childNodes.length);
        const browser = window.getSelection()!;
        browser.removeAllRanges();
        browser.addRange(range);
        return element.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
      }, otherNode),
    ).toBe(true);
    await rightClickSelection(mainProse, otherProse); // Restore a single-pane range.
    // An editor inside the selected transcript must keep its own context menu too.
    expect(
      await mainProse.evaluate((element) => {
        const editor = document.createElement("div");
        editor.contentEditable = "plaintext-only";
        element.after(editor);
        const allowed = editor.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
        editor.remove();
        return allowed;
      }),
    ).toBe(true);
    expect(await fixtureCall(page, "selectionMenus")).toEqual([]);
    expect(await rightClickSelection(otherProse)).toBe(false);
    expect(await fixtureCall(page, "selectionMenus")).toEqual(["B"]);
    // Navigate away while the menu is still pending; the surviving pane also has this ID.
    await fixtureCall(page, "switchConversation");
    await fixtureCall(page, "addFromSelectionMenu");
    await settle(page);
    await expect(page.getByRole("dialog", { name: "Add annotation" })).toHaveCount(0);
    await fixtureCall(page, "switchConversation");

    await main.getByRole("button", { name: "View response fullscreen" }).click();
    const fullscreen = page.getByRole("dialog", { name: "Cake", exact: true });
    const fullscreenProse = fullscreen.getByText(annotationProse, { exact: true });
    await expect(fullscreenProse).toBeVisible();
    expect(await rightClickSelection(fullscreenProse)).toBe(false);
    expect(await fixtureCall(page, "selectionMenus")).toEqual(["B", "A"]);
    await fixtureCall(page, "addFromSelectionMenu");
    const editor = page.getByRole("textbox", { name: "Annotation comment" });
    await editor.fill("Original note");
    await editor.press("Enter");
    await fullscreen.getByRole("button", { name: /Exit fullscreen/ }).click();
    await main.getByRole("button", { name: "View annotation 1", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Annotation details" });
    await details.getByRole("button", { name: "Edit annotation" }).click();
    const edit = details.getByRole("textbox", { name: "Edit annotation comment" });
    await edit.fill("Edited note");
    await edit.press("Enter");
    await expect(details.getByText("Edited note")).toBeVisible();
    const path = testInfo.outputPath("edited-annotation-in-owning-pane.png");
    await page.screenshot({ path });
    await testInfo.attach("edited-annotation-in-owning-pane", { path, contentType: "image/png" });
    await fixtureCall(page, "switchConversation");
    await expect(page.getByRole("button", { name: /View annotation/ })).toHaveCount(0);
    const composer = main.getByRole("combobox", { name: "Message", exact: true });
    await composer.fill("Unrelated send");
    await composer.press("Enter");
    await expect
      .poll(() => fixtureCall(page, "prompts"))
      .toEqual([
        expect.objectContaining({
          sessionId: "empty-conversation",
          text: "Unrelated send",
          attachments: [],
        }),
      ]);
    await fixtureCall(page, "switchConversation");
    await expect(
      main.getByRole("button", { name: "View annotation 1", exact: true }),
    ).toBeVisible();
    await composer.fill("Send the saved note");
    await composer.press("Enter");
    await expect
      .poll(() => fixtureCall(page, "prompts"))
      .toEqual([
        expect.objectContaining({ sessionId: "empty-conversation", attachments: [] }),
        expect.objectContaining({
          sessionId: "ownership",
          text: "Send the saved note",
          attachments: [
            {
              kind: "annotation",
              annotations: [
                expect.objectContaining({
                  messageId: "matching-id",
                  selectedText: annotationProse,
                  comment: "Edited note",
                }),
              ],
            },
          ],
        }),
      ]);
    await expect(main.getByRole("button", { name: "View annotation 1", exact: true })).toHaveCount(
      0,
    );
  });

  test("discard pending annotation dictation when its transcript unmounts", async ({
    fixturePage: page,
  }) => {
    const main = page.getByRole("region", { name: "Main pane" });
    await fixtureCall(page, "enableDictation");
    expect(await rightClickSelection(main.getByText(annotationProse, { exact: true }))).toBe(false);
    await fixtureCall(page, "addFromSelectionMenu");
    const editor = page.getByRole("textbox", { name: "Annotation comment" });
    await expect(editor).toBeFocused();
    await expect(
      page
        .getByRole("dialog", { name: "Add annotation" })
        .locator('[data-slot="dictation-indicator"]'),
    ).toHaveText("Listening");
    await fixtureCall(page, "dictate");
    await expect(editor).toHaveValue(/Dictated message/);
    await editor.press("Enter");
    // Wait for the final recognizer request, then navigate before it resolves.
    await expect.poll(() => fixtureCall(page, "recognitionPending")).toBe(true);
    await fixtureCall(page, "switchConversation");
    expect(await fixtureCall(page, "finishRecognition")).toBe(true);
    await settle(page);
    await expect(page.getByRole("dialog", { name: "Add annotation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /View annotation/ })).toHaveCount(0);
    await fixtureCall(page, "switchConversation");
    await expect(page.getByRole("button", { name: /View annotation/ })).toHaveCount(0);
  });
});

test("evidence: accepted Enter returns to bottom; explicit navigation also follows again", async ({
  fixturePage: page,
}) => {
  test.skip(!capture, "Recording only: CAKE_TRANSCRIPT_CAPTURE=1.");
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 900, height: 700 });
  const transcript = page.locator(".transcript");
  const input = page.getByRole("combobox", { name: "Message", exact: true });
  const shot = (name: string) => page.screenshot({ path: join(captureDirectory, `${name}.png`) });
  await mkdir(captureDirectory, { recursive: true });
  await fixtureCall(page, "startLive", 40, "text+tool+arrive");
  await page.waitForTimeout(2000);
  await shot("1-following-while-streaming");
  // The explicit arrow appears once more than a viewport of content lies below.
  await wheel(page, transcript, -1600);
  await shot("2-scrolled-up");
  const reading = await anchor(transcript);
  await page.waitForTimeout(4000);
  await shot("3-still-holding-after-4s-of-streaming");
  expect(await anchor(transcript)).toEqual(reading);
  await input.fill("Please summarize.");
  await page.waitForTimeout(500);
  await input.press("Enter");
  await expect.poll(() => fixtureCall(page, "submittedText")).toBe("Please summarize.");
  await settle(page);
  await expect.poll(() => gap(transcript)).toBeLessThan(1);
  await shot("4-enter-submitted-at-bottom");
  await wheel(page, transcript, -1600);
  const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
  await jump.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    process.platform === "darwin" ? "⌘↓" : "Scroll to bottom",
  );
  await shot("5-explicit-arrow-shortcut");
  await input.focus();
  if (process.platform === "darwin") await input.press("Meta+ArrowDown");
  else await jump.click();
  await expect.poll(() => gap(transcript)).toBeLessThan(1);
  await page.waitForTimeout(2500);
  await shot("6-following-again");
  expect(await gap(transcript)).toBeLessThan(1);
  await fixtureCall(page, "stopLive");
});

// Real-application follow checks ported from the retired react-virtuoso suite
// (session-scroll-position.smoke, superseded by fc455223): behaviors the renderer
// fixture above cannot reach, exercised against seeded Sessions through the real UI.
function seededTranscript(sessionId: string, project: string, title: string, count: number) {
  const timestamp = new Date(0).toISOString();
  const entries: Array<Record<string, unknown>> = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
    fixtureModelChange(timestamp),
  ];
  let parentId = "model";
  for (let index = 0; index < count; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const id = `${sessionId}-${index}`;
    const body = `${title} transcript item ${index}. ${"This line gives the message a distinct height. ".repeat((index % 6) + 1)}`;
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
              api: "openai-completions",
              provider: "fixture",
              model: "fixture-model",
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

async function launchSeededSessions(
  sessions: ReadonlyArray<{ id: string; title: string; count: number }>,
) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-transcript-follow-app-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all(
    [userData, project, sessionDirectory, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
    }),
  );
  const models = await startFixtureModelServer();
  await writeFixtureModels(cakeHome, { baseUrl: models.baseUrl });
  for (const [index, session] of sessions.entries())
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-0${index}-000Z_${session.id}.jsonl`),
      seededTranscript(session.id, project, session.title, session.count),
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
  const page = await application.firstWindow();
  await recordRendererErrors(page);
  return {
    application,
    page,
    models,
    async close() {
      await application.close();
      await models.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

/** The newest rendered row, by display index. */
function lastRowText(transcript: Locator) {
  return transcript.evaluate((element) => {
    const rows = [...element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]')];
    return rows.sort(
      (left, right) =>
        Number(right.dataset.transcriptItemIndex) - Number(left.dataset.transcriptItemIndex),
    )[0]?.textContent;
  });
}

async function openAtEnd(page: Page, title: string, lastIndex: number) {
  await openSession(page, title);
  // The outgoing transition snapshot is inert DOM, not a second live transcript.
  const transcript = page.locator(
    '.transcript:visible:not([data-slot="content-transition-outgoing"] *)',
  );
  await expect
    .poll(() => lastRowText(transcript))
    .toContain(`${title} transcript item ${lastIndex}`);
  await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
  return transcript;
}

async function openRow(page: Page, sessionId: string) {
  const workspace = await showSessions(page);
  await workspace.locator(`.session-item[data-session-id="${sessionId}"] .session-row`).click();
}

test.describe("real application", () => {
  test("a reader's position holds while another session streams and completes", async () => {
    test.setTimeout(90_000);
    const app = await launchSeededSessions([
      { id: "follow-first", title: "First follow fixture", count: 48 },
      { id: "follow-second", title: "Second follow fixture", count: 48 },
    ]);
    try {
      const { page, models } = app;
      const transcript = await openAtEnd(page, "First follow fixture", 47);
      await wheel(page, transcript, -2000);
      await page.waitForTimeout(300);
      const reading = await anchor(transcript);
      expect(reading).toBeDefined();
      await openRow(page, "follow-second");
      await expect
        .poll(() => lastRowText(transcript))
        .toContain("Second follow fixture transcript item 47");
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await composer.click();
      await page.keyboard.type("Stream in the other session");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect.poll(() => models.assistantRequests.length).toBe(1);
      models.write("Background response started.\n\n");
      await expect(transcript).toContainText("Background response started.");
      await openRow(page, "follow-first");
      await expect.poll(() => anchor(transcript)).toEqual(reading);
      models.write("Background content keeps growing.\n\n".repeat(100));
      models.release();
      await page.waitForTimeout(500);
      expect(await anchor(transcript)).toEqual(reading);
      expect(await recordedRendererErrors(page)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("a large loaded session reopens at its end and scrolls to its start without errors", async () => {
    test.setTimeout(120_000);
    const app = await launchSeededSessions([
      { id: "follow-large", title: "Large follow fixture", count: 480 },
      { id: "follow-small", title: "Small follow fixture", count: 8 },
    ]);
    try {
      const { page } = app;
      const transcript = await openAtEnd(page, "Large follow fixture", 479);
      await openRow(page, "follow-small");
      await expect
        .poll(() => lastRowText(transcript))
        .toContain("Small follow fixture transcript item 7");
      await openRow(page, "follow-large");
      await expect
        .poll(() => lastRowText(transcript))
        .toContain("Large follow fixture transcript item 479");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      // Scrolling upward mounts ever earlier rows; none of those commits may error.
      await transcript.hover({ position: { x: 20, y: 200 } });
      for (let step = 0; step < 400; step++) {
        if ((await transcript.evaluate((element) => element.scrollTop)) < 1) break;
        await page.mouse.wheel(0, -3000);
        await page.waitForTimeout(16);
      }
      await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(1);
      await expect(transcript.getByText("Large follow fixture", { exact: true })).toBeVisible();
      expect(await recordedRendererErrors(page)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("rows that shrink while following keep the end and mount earlier rows without errors", async () => {
    test.setTimeout(90_000);
    const app = await launchSeededSessions([
      { id: "follow-reflow", title: "Reflow follow fixture", count: 48 },
    ]);
    try {
      const { application, page } = app;
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(820, 800),
      );
      const transcript = await openAtEnd(page, "Reflow follow fixture", 47);
      // Widening the real window reflows every row shorter, so the list mounts rows above.
      for (const width of [1100, 1500, 1800]) {
        await application.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]!.setContentSize(width, 800),
          width,
        );
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
        await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      }
      expect(await recordedRendererErrors(page)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
