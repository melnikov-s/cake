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
      const transcript = page.locator(".transcript");
      await expect(
        transcript.getByText(
          withUpdates ? "Make widgets follow Cake theme live" : `Message ${messageCount - 1}.`,
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
  test("rule 1: sending preserves the reader; explicit navigation scrolls to the bottom", async ({
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

    // Both composer paths submit without moving the reading anchor.
    for (const method of ["Enter", "button"]) {
      const text = `Keep my place (${method}).`;
      await input.fill(text);
      if (method === "Enter") await input.press("Enter");
      else await page.getByRole("button", { name: "Send", exact: true }).click();
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
    await expect(transcript.getByText("Keep my place (button).")).toBeVisible();

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

  test("writing clears keyboard selection but sending preserves the reading position", async ({
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
    const reading = await anchor(transcript);
    await input.press("Enter");
    await expect
      .poll(() => fixtureCall(page, "submittedText"))
      .toBe("Send without moving the reading position.");
    await settle(page);
    await expect(selected).toHaveCount(0);
    expect(await anchor(transcript)).toEqual(reading);
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
    const samples = await anchorEveryFrame(page, async () => {
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
    });
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
    const frames = await pinnedFrames(page, () => streamFor(page, 2000));
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

test("reopening a conversation restores the reader's position", async ({ fixturePage: page }) => {
  const transcript = page.locator(".transcript");
  await wheel(page, transcript, -1500);
  const reading = await anchor(transcript);
  await page.waitForTimeout(200);
  await fixtureCall(page, "switchConversation");
  await fixtureCall(page, "switchConversation");
  await settle(page);
  await expect.poll(() => anchor(transcript)).toEqual(reading);
});

test("evidence: sending holds the reading position; explicit navigation follows again", async ({
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
  expect(await anchor(transcript)).toEqual(reading);
  await shot("4-sent-still-reading");
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
