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
const test = base.extend<{
  fixturePage: Page;
  messageCount: number;
  chatMode: string;
  withWidget: boolean;
  withUpdates: boolean;
  withImages: boolean;
}>({
  withImages: [false, { option: true }],
  withUpdates: [false, { option: true }],
  withWidget: [false, { option: true }],
  messageCount: [48, { option: true }],
  chatMode: ["", { option: true }],
  fixturePage: async ({ messageCount, chatMode, withWidget, withUpdates, withImages }, use) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-transcript-ownership-"));
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
          { html, messageCount, chatMode, widget, withUpdates, withImages },
        ) => {
          // Match the application window: a hidden window must not throttle
          // animation frames, or Virtuoso never finishes initial positioning.
          const window = new BrowserWindow({
            show: false,
            webPreferences: { sandbox: true, backgroundThrottling: false },
          });
          await window.loadFile(html, {
            search: `?count=${messageCount}&chatMode=${chatMode}&updates=${withUpdates}&images=${withImages}&widget=${encodeURIComponent(JSON.stringify(widget))}`,
          });
        },
        { html, messageCount, chatMode, widget, withUpdates, withImages },
      );
      const page = await opened;
      const transcript = page.locator(".transcript");
      await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
        withUpdates ? "Make widgets follow Cake theme live" : `Message ${messageCount - 1}`,
      );
      // Virtuoso hides the list until its initial position settles.
      await expect(transcript.locator('[aria-label="Conversation"]')).toBeVisible();
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await use(page);
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
});

for (const chatMode of ["full", "compact"]) {
  test.describe(`${chatMode} instruction baseline reconciliation`, () => {
    test.use({ messageCount: 2, chatMode });
    test("keeps late baseline pills at the top and real instruction updates after dialogue", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const reconcile = async () =>
        page.evaluate(() => {
          const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
          fixture.partsUpdated([
            {
              id: "runtime-system-prompt-system",
              kind: "context",
              title: "System",
              text: "Baseline rules",
            },
            {
              id: "runtime-system-prompt-skills",
              kind: "context",
              title: "Skills",
              text: "Baseline skills",
            },
            {
              id: "runtime-system-prompt-instructions",
              kind: "context",
              title: "AGENTS.md",
              text: "Baseline project rules",
            },
            {
              id: "live-context-1-system-prompt-skills",
              kind: "context",
              title: "Skills",
              text: "Genuine skill change",
            },
          ]);
        });
      const anchors = () =>
        transcript
          .locator('[data-slot="transcript-item"]')
          .evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-transcript-anchor-id")),
          );
      const expected = [
        "runtime-system-prompt-system",
        "message-0",
        "message-1",
        "live-context-1-system-prompt-skills",
      ];
      await reconcile();
      await expect.poll(anchors).toEqual(expected);
      const baseline = transcript.locator('[data-slot="context-group"]').first();
      await expect(baseline.getByRole("button", { name: "System", exact: true })).toHaveCount(1);
      await expect(baseline.getByRole("button", { name: "Skills", exact: true })).toHaveCount(1);
      await expect(baseline.getByRole("button", { name: "AGENTS.md", exact: true })).toHaveCount(1);
      await reconcile();
      await expect.poll(anchors).toEqual(expected);
      await page.evaluate(() =>
        (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).update(),
      );
      await expect.poll(anchors).toEqual(expected);
      await expect(transcript.locator('[data-slot="context-group"]')).toHaveCount(2);
    });
  });
}

for (const chatMode of ["virtualized", "compact"]) {
  test.describe(`${chatMode} sending from distant history`, () => {
    test.use({ messageCount: 2000, chatMode, withImages: true });
    test("Enter reaches the measured bottom and Shift+Enter keeps the reading position", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await settle(page);
      await transcript.focus();
      await page.keyboard.press("Home");
      await settle(page);
      expect(await gap(transcript)).toBeGreaterThan(10000);
      await composer.focus();
      await composer.pressSequentially("Send from distant history");
      await expect(composer).toHaveValue("Send from distant history");
      await expect(composer).toBeFocused();
      await transcript
        .locator("img")
        .evaluateAll((images) =>
          Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
        );
      await settle(page);
      const saved = await anchor(transcript);
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue("Send from distant history\n");
      await settle(page);
      expect(await anchor(transcript)).toEqual(saved);
      await page.evaluate(() => {
        const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
        for (let step = 0; step < 12; step++) fixture.grow("message-1999");
      });
      await composer.press("Enter");
      await expect(composer).toHaveValue("");
      await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
        "Send from distant history",
      );
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      for (const operation of ["arrive", "stream", "activity"] as const) {
        await command(page, operation);
        await settle(page);
        expect(await gap(transcript)).toBeLessThanOrEqual(1);
      }
    });
  });
}

for (const chatMode of ["virtualized", "compact"]) {
  test.describe(`${chatMode} image-heavy virtual history`, () => {
    test.use({ chatMode });
    test.use({ messageCount: 80, withImages: true });
    test("manual upward scrolling keeps its anchor when older Markdown images finish loading", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const waiting: Array<() => Promise<void>> = [];
      let released = false;
      await page.route("https://transcript.invalid/**", (route) => {
        const finish = () =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"/>',
          });
        if (released) return finish();
        waiting.push(finish);
      });
      await wheel(page, transcript, -3500);
      await wheel(page, transcript, -1600);
      await settle(page);
      expect(waiting.length).toBeGreaterThan(0);
      const saved = await anchor(transcript);
      released = true;
      await Promise.all(waiting.map((finish) => finish()));
      await transcript
        .locator("img")
        .evaluateAll((images) =>
          Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
        );
      await settle(page);
      expect(await anchor(transcript)).toEqual(saved);
      expect(await gap(transcript)).toBeGreaterThan(1000);
      await command(page, "arrive");
      await settle(page);
      expect(await anchor(transcript)).toEqual(saved);
      await wheel(page, transcript, -180);
      await settle(page);
      const moved = await anchor(transcript);
      expect(moved).not.toEqual(saved);
      await command(page, "stream");
      await settle(page);
      expect(await anchor(transcript)).toEqual(moved);
    });
  });
}

test.describe("compact transcript density", () => {
  test.use({ chatMode: "compact", messageCount: 2000 });
  test("keeps long compact transcripts virtualized without losing compact spacing", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const rows = transcript.locator('[data-slot="transcript-item"]');
    await expect.poll(() => rows.count()).toBeLessThan(100);
    await expect(transcript.locator('[data-virtuoso-scroller="true"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="chat"]')).toHaveClass(/chat-layout-compact/);
    expect(
      await transcript
        .locator('[aria-label="Conversation"]')
        .evaluate(
          (element) =>
            parseFloat(getComputedStyle(element).paddingLeft) /
            parseFloat(getComputedStyle(document.documentElement).fontSize),
        ),
    ).toBe(0.75);
    await transcript.focus();
    await page.keyboard.press("Home");
    await expect(rows.first()).toContainText("Message 0.");
    await expect.poll(() => rows.count()).toBeLessThan(100);
  });
});

test("delayed image growth above history is compensated at every painted frame", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  await wheel(page, transcript, -1600);
  await settle(page);
  const saved = await anchor(transcript);
  const samples = await transcript.evaluate(async (element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")];
    const reading = rows.find((row) => row.getBoundingClientRect().bottom > viewportTop + 1)!;
    const above = rows.filter((row) => row.getBoundingClientRect().bottom <= viewportTop).at(-1)!;
    const image = document.createElement("img");
    above.append(image);
    const offsets: number[] = [];
    image.src =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="500" height="280"/>';
    await image.decode();
    for (let frame = 0; frame < 8; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      offsets.push(reading.getBoundingClientRect().top - viewportTop);
    }
    image.style.height = "460px";
    for (let frame = 0; frame < 8; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      offsets.push(reading.getBoundingClientRect().top - viewportTop);
    }
    return offsets;
  });
  expect(samples).toEqual(Array(16).fill(saved.offset));
  await expect.poll(() => anchor(transcript)).toEqual(saved);
  await command(page, "arrive");
  await settle(page);
  expect(await anchor(transcript)).toEqual(saved);
});

const gap = (transcript: Locator) =>
  transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
const top = (transcript: Locator) => transcript.evaluate((element) => element.scrollTop);
const command = (
  page: Page,
  operation: Exclude<keyof TranscriptOwnershipFixture, "grow" | "newestId">,
) =>
  page.evaluate((operation) => {
    (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture)[operation]();
  }, operation);
const anchor = (transcript: Locator) =>
  transcript.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].find(
      (item) => item.getBoundingClientRect().bottom > top + 1,
    )!;
    return { id: row.dataset.transcriptAnchorId, offset: row.getBoundingClientRect().top - top };
  });
async function wheel(page: Page, transcript: Locator, delta: number) {
  await transcript.hover({ position: { x: 20, y: 200 } });
  await transcript.evaluate((element) => {
    element.dataset.settled = "false";
    element.addEventListener(
      "scrollend",
      () => {
        element.dataset.settled = "true";
      },
      { once: true },
    );
  });
  await page.mouse.wheel(0, delta);
  await expect(transcript).toHaveAttribute("data-settled", "true");
}

// Real Root/Models/Stores, ChatTranscript, Virtuoso, native layout and observers.
// Only projection delivery and commit ordering are controlled by the fixture.
test.describe("long transcript layout", () => {
  test.use({ messageCount: 2000 });
  test("fractional row geometry settles during transcript layout updates", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    for (const size of [13, 14, 15, 16, 17, 18, 19, 20]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, size);
      await command(page, "stream");
      await settle(page);
      await expect(transcript.locator('[aria-label="Conversation"]')).toBeVisible();
      await wheel(page, transcript, -10000);
      await command(page, "arrive");
      await wheel(page, transcript, 10000);
    }
  });
});

test("size-result commits do not republish native scroll geometry", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  await settle(page);
  const reads = await transcript.evaluate((element) => {
    const offsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    )!.get!;
    let reads = 0;
    Object.defineProperty(element, "offsetHeight", {
      configurable: true,
      get() {
        reads++;
        return offsetHeight.call(this);
      },
    });
    try {
      // Deliver a real authority update and flush its React commit, before the
      // browser delivers any queued scroll or ResizeObserver notifications.
      const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
      const readsPerUpdate: number[] = [];
      for (let update = 0; update < 20; update++) {
        reads = 0;
        fixture.stream();
        readsPerUpdate.push(reads);
      }
      return readsPerUpdate;
    } finally {
      Reflect.deleteProperty(element, "offsetHeight");
    }
  });
  expect(reads).toEqual(Array(20).fill(0));
  await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
  // Streaming must keep the list virtualized rather than settling by mounting
  // every row or dropping the reader's bottom position.
  expect(await transcript.locator('[data-slot="transcript-item"]').count()).toBeLessThan(48);
});

test("layout commits never undo user movement before its scroll event", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  await wheel(page, transcript, -180);
  await transcript.evaluate((element) => {
    const original = element.scrollBy.bind(element);
    const writes: unknown[] = [];
    element.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
      writes.push({
        top: element.scrollTop,
        options,
        height: element.scrollHeight,
        stack: new Error().stack,
      });
      if (typeof options === "number") original(options, y!);
      else original(options);
    };
    Reflect.set(element, "compensationWrites", writes);
  });
  for (let step = 0; step < 8; step++) {
    const result = await transcript.evaluate((element, step) => {
      const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
      const before = element.scrollTop;
      // Model a compositor/inertial step before its queued scroll event. Do not
      // dispatch another wheel: a gesture does not promise one per native step.
      element.scrollTop -= 60;
      const intended = element.scrollTop;
      const viewportTop = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].find(
        (item) => item.getBoundingClientRect().bottom > viewportTop + 1,
      )!;
      const intendedAnchor = {
        id: row.dataset.transcriptAnchorId,
        offset: row.getBoundingClientRect().top - viewportTop,
      };
      if (step % 2) fixture.stream();
      else fixture.update(); // A context/footer commit with no height change also reproduced it.
      // The commit may measure rows and change virtual padding above the reader;
      // compensating that is allowed. What the reader sees must be their movement.
      const committedRow = element.querySelector<HTMLElement>(
        `[data-transcript-anchor-id="${intendedAnchor.id}"]`,
      )!;
      return {
        before,
        intended,
        intendedAnchor,
        committedOffset: committedRow.getBoundingClientRect().top - viewportTop,
        actual: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
      };
    }, step);
    expect(result.committedOffset, JSON.stringify(result)).toBe(result.intendedAnchor.offset);
    await expect
      .poll(async () => ({
        anchor: await anchor(transcript),
        writes: await transcript.evaluate((element) => Reflect.get(element, "compensationWrites")),
      }))
      // Later range measurements may change padding above the viewport. Only
      // anchor-preserving correction is allowed, never total-height scrollBy.
      .toEqual({ anchor: result.intendedAnchor, writes: [] });
  }
  const saved = await anchor(transcript);
  for (let step = 0; step < 6; step++) {
    await command(page, step % 2 ? "activity" : "stream");
    await expect.poll(() => anchor(transcript)).toEqual(saved);
    expect(await gap(transcript)).toBeGreaterThan(500);
  }
});

test("touch scrolling and its inertia stop following; sending returns to the bottom", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  const result = await transcript.evaluate((element) => {
    const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
    const touch = (clientY: number) => new Touch({ identifier: 1, target: element, clientY });
    element.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(200)], bubbles: true }));
    element.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(260)], bubbles: true }));
    element.scrollTop -= 120;
    const dragged = element.scrollTop;
    fixture.stream();
    const afterDrag = element.scrollTop;
    element.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
    // Native inertia continues after the finger lifts, without further input.
    element.scrollTop -= 60;
    const intended = element.scrollTop;
    fixture.stream();
    return { dragged, afterDrag, intended, actual: element.scrollTop };
  });
  expect(result.afterDrag).toBe(result.dragged);
  expect(result.actual).toBe(result.intended);
  await expect.poll(() => top(transcript)).toBe(result.intended);
  const saved = await anchor(transcript);
  await command(page, "activity");
  await expect.poll(() => anchor(transcript)).toEqual(saved);
  // Sending a message is an explicit request to return to the newest content.
  await command(page, "insert");
  await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
  for (let step = 0; step < 4; step++) {
    await command(page, "stream");
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
  }
});

test("remeasurement cannot turn downward intent into bottom ownership", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  await wheel(page, transcript, -180);
  const saved = await top(transcript);
  await transcript.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
    // A viewport/virtual-size change makes the same position appear bottom-pinned.
    element.style.height = `${element.scrollHeight - element.scrollTop}px`;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(new Event("scrollend"));
    element.style.removeProperty("height");
  });
  for (let step = 0; step < 4; step++) {
    await command(page, "stream");
    await expect.poll(() => top(transcript)).toBe(saved);
  }
  // A later real downward gesture, against stable geometry, can follow again.
  await wheel(page, transcript, 10000);
  await command(page, "stream");
  await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
});

test("PageUp and Home keep ownership across updates; deliberate insertion recovers", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  await transcript.focus();
  await page.keyboard.press("PageUp");
  await expect.poll(() => gap(transcript)).toBeGreaterThan(100);
  await command(page, "stream");
  expect(await gap(transcript)).toBeGreaterThan(100);
  await page.keyboard.press("Home");
  await expect.poll(() => top(transcript)).toBe(0);
  for (let step = 0; step < 4; step++) {
    await command(page, "activity");
    expect(await top(transcript)).toBe(0);
  }
  // End the native gesture before granting an explicit insertion exception.
  await transcript.evaluate((element) => element.dispatchEvent(new Event("scrollend")));
  await command(page, "insert");
  await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
});

for (const chatMode of ["virtualized", "compact"]) {
  test.describe(`${chatMode} tool expansion`, () => {
    test.use({ chatMode });
    test("tool expansion and late nested media keep the reader's visible anchor", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      await command(page, "activity");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await wheel(page, transcript, -120);
      const saved = await anchor(transcript);
      const activity = transcript.locator('[data-slot="activity-group"]');
      const disclosure = activity.locator("summary");
      // This test isolates expansion/resize, not Playwright's offscreen-target
      // auto-scroll (which legitimately changes the reader's position first).
      await disclosure.evaluate((element) => element.click());
      await expect(activity).toHaveAttribute("open", "");
      await expect.poll(() => anchor(transcript)).toEqual(saved);
      for (let step = 0; step < 4; step++) {
        await command(page, "activity");
        await expect.poll(() => anchor(transcript)).toEqual(saved);
      }
      // A late intrinsic media height inside a real overscanned transcript row is
      // measured by the same observers as tool/artifact content. No fake geometry.
      await transcript.evaluate(async (element) => {
        const viewportTop = element.getBoundingClientRect().top;
        const row = [
          ...element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
        ].find((row) => row.getBoundingClientRect().bottom <= viewportTop)!;
        const image = document.createElement("img");
        row.append(image);
        image.src =
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="180"/>';
        await image.decode();
      });
      await expect.poll(() => anchor(transcript)).toEqual(saved);
      await disclosure.evaluate((element) => element.click());
      await expect(activity).not.toHaveAttribute("open");
      await expect.poll(() => anchor(transcript)).toEqual(saved);
    });
  });
}

test("user input supersedes navigation measurement retries", async ({ fixturePage: page }) => {
  const transcript = page.locator(".transcript");
  await command(page, "navigate");
  await expect(transcript.locator('[aria-current="true"]')).toContainText("Message 5");
  const result = await transcript.evaluate((element) => {
    const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    element.scrollTop -= 80;
    const intended = element.scrollTop;
    fixture.stream();
    return { intended, actual: element.scrollTop };
  });
  expect(result.actual).toBe(result.intended);
  for (let step = 0; step < 8; step++) {
    await command(page, step % 2 ? "stream" : "update");
    const tops = await transcript.evaluate(async (element) => {
      const tops: number[] = [];
      for (let frame = 0; frame < 3; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        tops.push(element.scrollTop);
      }
      return tops;
    });
    expect(tops).toEqual([result.intended, result.intended, result.intended]);
  }
});

for (const chatMode of ["virtualized", "compact"]) {
  test.describe(`${chatMode} keyboard navigation`, () => {
    test.use({ chatMode });
    test("pauses streaming follow during navigation; leaving it never scrolls", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const selected = transcript.locator('[data-slot="transcript-item"][aria-current="true"]');
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await command(page, "stream");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await composer.focus();
      await composer.press("ArrowUp");
      await expect(selected).toContainText("Streaming chunk.");
      const saved = await top(transcript);
      for (let step = 0; step < 4; step++) {
        await command(page, "stream");
        await page.evaluate(async () => {
          for (let frame = 0; frame < 6; frame++)
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => setTimeout(resolve, 0)),
            );
        });
        expect(Math.abs((await top(transcript)) - saved)).toBeLessThanOrEqual(1);
      }
      await composer.press("ArrowUp");
      await expect(selected).toContainText("Message 47.");
      await composer.press("ArrowDown");
      await expect(selected).toContainText("Streaming chunk.");
      await wheel(page, transcript, -180);
      const readingTop = await top(transcript);
      for (let step = 0; step < 4; step++) {
        await command(page, "stream");
        await expect.poll(() => top(transcript)).toBe(readingTop);
      }
      // Down past the newest message returns focus to writing, not the viewport.
      await composer.press("ArrowDown");
      await expect(selected).toHaveCount(0);
      await expect(composer).toBeFocused();
      for (let step = 0; step < 4; step++) {
        await command(page, "stream");
        await settle(page);
        expect(await top(transcript)).toBe(readingTop);
      }
      // The reader returning to the bottom resumes following.
      await wheel(page, transcript, 10_000);
      for (let step = 0; step < 4; step++) {
        await command(page, "stream");
        await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      }
    });
  });
}

for (const chatMode of ["virtualized", "compact"]) {
  test.describe(`${chatMode} inline widget reading position`, () => {
    test.use({ withWidget: true, chatMode });

    test("scrolling over the widget pauses outer bottom following", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const iframe = transcript.locator("iframe");
      await expect(transcript.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
      const bounds = (await iframe.boundingBox())!;
      const viewport = (await transcript.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, Math.max(viewport.y, bounds.y) + 30);
      const before = await top(transcript);
      await page.mouse.wheel(0, -200);
      await expect.poll(() => top(transcript)).toBeLessThan(before - 100);
      const saved = await top(transcript);
      const savedAnchor = await anchor(transcript);
      await command(page, "stream");
      await expect.poll(() => top(transcript)).toBe(saved);
      await expect.poll(() => anchor(transcript)).toEqual(savedAnchor);
    });

    test("widget remains rendered during away-from-bottom streaming, reopen and virtual range changes", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const disclosure = transcript.locator('[data-slot="artifact-disclosure"]');
      const iframe = disclosure.locator("iframe");
      const content = iframe.contentFrame();
      await expect(disclosure.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
      await wheel(page, transcript, -500);
      await expect(content.getByRole("heading", { name: "Saved widget content" })).toBeVisible();
      await expect(disclosure.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
      const saved = await anchor(transcript);
      const initialTop = await top(transcript);
      const originalSrc = await iframe.getAttribute("src");
      for (let step = 0; step < 12; step++) {
        await command(page, step % 3 === 0 ? "activity" : "stream");
        await expect.poll(() => anchor(transcript)).toEqual(saved);
        // Record both native scrolling and item coordinates: a virtual padding
        // shift can move the reader even when scrollTop has not changed.
        expect(await top(transcript)).toBe(initialTop);
        await expect(content.getByRole("heading", { name: "Saved widget content" })).toBeVisible();
        expect(await iframe.getAttribute("src")).toBe(originalSrc);
      }
      const collapse = disclosure.getByRole("button", { name: "Scroll widget Collapse" });
      await collapse.focus();
      await collapse.press("Enter");
      await expect(iframe).toHaveCount(0);
      const expand = disclosure.getByRole("button", { name: "Scroll widget Expand" });
      await expand.focus();
      await expand.press("Enter");
      await expect(content.getByRole("heading", { name: "Saved widget content" })).toBeVisible();
      await expect(disclosure.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
      // Leave the virtual range entirely, then return via a user gesture. A new
      // mount must hydrate and paint without requiring an extra corrective scroll.
      await wheel(page, transcript, -10000);
      await expect(iframe).toHaveCount(0);
      await wheel(page, transcript, initialTop - (await top(transcript)));
      await expect(content.getByRole("heading", { name: "Saved widget content" })).toBeVisible();
      await expect(disclosure.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
      await command(page, "insert");
      for (let step = 0; step < 4; step++) {
        await command(page, "stream");
        await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      }
    });
  });
}

for (const chatMode of ["full", "compact"]) {
  test.describe(`${chatMode} response expansion`, () => {
    test.use({ withUpdates: true, chatMode });

    for (const position of ["bottom", "history"]) {
      test(`preserves the response start at ${position}, then lets the reader scroll`, async ({
        fixturePage: page,
      }) => {
        const transcript = page.locator(".transcript");
        if (position === "history") {
          await wheel(page, transcript, -40);
          for (let index = 0; index < 6; index++) await command(page, "arrive");
          await expect.poll(() => gap(transcript)).toBeGreaterThan(300);
        }
        const offset = (trigger: Locator) =>
          trigger.evaluate(
            (button) =>
              button.getBoundingClientRect().top -
              button.closest(".transcript")!.getBoundingClientRect().top,
          );
        const expectHeld = async (trigger: Locator, saved: number) => {
          const samples = await trigger.evaluate(async (button) => {
            const samples: number[] = [];
            for (let frame = 0; frame < 12; frame++) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => setTimeout(resolve, 0)),
              );
              samples.push(
                button.getBoundingClientRect().top -
                  button.closest(".transcript")!.getBoundingClientRect().top,
              );
            }
            return samples;
          });
          expect(
            samples.every((sample) => Math.abs(sample - saved) <= 1),
            JSON.stringify({ saved, samples, title: await trigger.textContent() }),
          ).toBe(true);
        };
        const source = page.getByRole("button", {
          name: "Sync open VS Code with Cake theme changes",
          exact: true,
        });
        const fallback = page.getByRole("button", {
          name: "Make widgets follow Cake theme live",
          exact: true,
        });
        for (const [trigger, original] of [
          [source, true],
          [fallback, false],
        ] as const) {
          await trigger.scrollIntoViewIfNeeded();
          await settle(page);
          const saved = await offset(trigger);
          expect(saved).toBeGreaterThanOrEqual(0);
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          if (original) {
            await expect(page.getByText("Loading original response")).toBeVisible();
            await expectHeld(trigger, saved);
            await command(page, "loadReport");
            await expect(page.getByRole("heading", { name: "Report start" })).toBeInViewport();
          }
          await expectHeld(trigger, saved);
          // Later output still must not pull the opened report to the bottom.
          await command(page, "stream");
          await expectHeld(trigger, saved);
          const body = page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
          expect(await body.evaluate((element) => element.scrollHeight)).toBeGreaterThan(600);
          // Expanded responses are part of the transcript, not nested scroll
          // traps. Wheel over the body and read it through the outer scroller.
          expect(
            await body.evaluate((element) => element.scrollHeight - element.clientHeight),
          ).toBeLessThanOrEqual(1);
          const before = await top(transcript);
          const bounds = await body.boundingBox();
          await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
          await page.mouse.wheel(0, 180);
          await expect.poll(() => top(transcript)).toBeGreaterThan(before + 100);
          expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
          await trigger.scrollIntoViewIfNeeded();
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
          const reopened = await offset(trigger);
          // Keyboard activation must pause following too.
          await trigger.focus();
          await trigger.press("Enter");
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          await expectHeld(trigger, reopened);
          if (original) expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
          await trigger.click();
        }
      });
    }
  });
}

test.describe("short transcript", () => {
  test.use({ messageCount: 2 });
  test("follows growing content only until the user leaves bottom", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    for (let step = 0; step < 6; step++) {
      await command(page, "stream");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    }
    await wheel(page, transcript, -180);
    // The streamed message's entrance animation is paint, not a reading position.
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>("[data-transcript-item-key]")].every(
        (row) => row.getAnimations().length === 0,
      ),
    );
    const saved = await anchor(transcript);
    for (let step = 0; step < 4; step++) {
      await command(page, "stream");
      await expect.poll(() => anchor(transcript)).toEqual(saved);
    }
  });
});

// Regression contract for the recurring "transcript scrolls while I am reading"
// bug: away from the bottom, nothing but the reader moves the viewport.
test.describe("reader away from the bottom", () => {
  test("streaming, arriving messages and tool output never move the viewport", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await wheel(page, transcript, -400);
    const savedTop = await top(transcript);
    const savedAnchor = await anchor(transcript);
    for (const operation of ["stream", "arrive", "activity", "stream", "arrive"] as const) {
      await command(page, operation);
      await settle(page);
      expect(await anchor(transcript)).toEqual(savedAnchor);
      expect(await top(transcript)).toBe(savedTop);
    }
  });

  test("scrolling away without wheel, touch or keys stops following", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    // A scrollbar drag (overlay scrollbars included), find-in-page or a focus
    // scroll moves the viewport without any wheel/touch/key event.
    for (const pointer of [true, false]) {
      if ((await gap(transcript)) > 1) await wheel(page, transcript, 10_000);
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await settle(page);
      await transcript.evaluate((element, pointer) => {
        if (pointer) element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        element.scrollTop -= 300;
      }, pointer);
      await settle(page);
      if (pointer) await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup")));
      const savedTop = await top(transcript);
      const savedAnchor = await anchor(transcript);
      expect(await gap(transcript)).toBeGreaterThan(250);
      for (const operation of ["stream", "arrive", "activity"] as const) {
        await command(page, operation);
        await settle(page);
        expect(await top(transcript)).toBe(savedTop);
        expect(await anchor(transcript)).toEqual(savedAnchor);
      }
    }
  });

  test("content growth above the viewport keeps the visible content still", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await wheel(page, transcript, -600);
    const savedAnchor = await anchor(transcript);
    const savedTop = await top(transcript);
    const above = await transcript.evaluate((element) => {
      const viewportTop = element.getBoundingClientRect().top;
      return [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")]
        .filter((row) => row.getBoundingClientRect().bottom < viewportTop)
        .at(-1)?.dataset.transcriptAnchorId;
    });
    expect(above).toBeDefined();
    await page.evaluate((messageId) => {
      (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).grow(messageId!);
    }, above);
    await settle(page);
    expect(await anchor(transcript)).toEqual(savedAnchor);
    // The viewport moved by exactly the growth above it, so nothing visible moved.
    expect(await top(transcript)).toBeGreaterThan(savedTop + 100);
  });

  test("following stops on a slight upward scroll and resumes only at the bottom", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    for (const operation of ["stream", "arrive", "activity"] as const) {
      await command(page, operation);
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    }
    await wheel(page, transcript, -40);
    const savedTop = await top(transcript);
    for (const operation of ["stream", "arrive"] as const) {
      await command(page, operation);
      await settle(page);
      expect(await top(transcript)).toBe(savedTop);
    }
    await wheel(page, transcript, 10_000);
    for (const operation of ["stream", "arrive", "activity"] as const) {
      await command(page, operation);
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    }
  });
});

for (const chatMode of ["virtualized", "compact"]) {
  test.describe(`${chatMode} keyboard selection while messages arrive`, () => {
    test.use({ chatMode });
    test("keeps the selected message and the viewport; arrows continue from it", async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const selected = transcript.locator('[data-slot="transcript-item"][aria-current="true"]');
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      const selectedOffset = () =>
        selected.evaluate((row) => {
          const scroller = row.closest<HTMLElement>(".transcript")!;
          return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
      await composer.focus();
      for (let press = 0; press < 3; press++) await composer.press("ArrowUp");
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", "message-45");
      await settle(page);
      const savedTop = await top(transcript);
      const savedOffset = await selectedOffset();
      for (const operation of ["arrive", "stream", "activity", "stream", "arrive"] as const) {
        await command(page, operation);
        await settle(page);
        await expect(selected).toHaveAttribute("data-transcript-anchor-id", "message-45");
        expect(await top(transcript)).toBe(savedTop);
        expect(await selectedOffset()).toBe(savedOffset);
      }
      // Content above the selection may change height too (a settled or
      // highlighted message, a late image); the selected message stays put.
      await page.evaluate(() => {
        (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).grow("message-43");
      });
      await settle(page);
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", "message-45");
      expect(await selectedOffset()).toBe(savedOffset);
      // Arrow keys move relative to the selected message's identity.
      await composer.press("ArrowUp");
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", "message-44");
      await composer.press("ArrowDown");
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", "message-45");
      // Leaving the newest message returns focus to writing without scrolling.
      // Down to the newest message (each press may reveal its message), then
      // read slightly above the bottom before leaving the selection.
      const newest = await page.evaluate(() =>
        (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).newestId(),
      );
      for (let press = 0; press < 12; press++) {
        if ((await selected.getAttribute("data-transcript-anchor-id")) === newest) break;
        await composer.press("ArrowDown");
      }
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", newest!);
      await wheel(page, transcript, -300);
      const beforeLeaving = await top(transcript);
      expect(await gap(transcript)).toBeGreaterThan(100);
      // Leaving the newest message returns focus to writing, never to the bottom.
      await composer.press("ArrowDown");
      await expect(selected).toHaveCount(0);
      await expect(composer).toBeFocused();
      await settle(page);
      expect(await top(transcript)).toBe(beforeLeaving);
      await command(page, "arrive");
      await settle(page);
      expect(await top(transcript)).toBe(beforeLeaving);
      // Sending a message is the one exception: it scrolls to the bottom and follows.
      await composer.fill("Send from the middle");
      await composer.press("Enter");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await command(page, "arrive");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    });
  });
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

const live = (page: Page, mode: "text" | "text+tool+arrive" | false) =>
  page.evaluate((mode) => {
    const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
    if (mode) fixture.startLive(16, mode);
    else fixture.stopLive();
  }, mode);

// Compare final post-layout geometry on the next frame, after it painted.
// Raw scrollTop can increase when virtual measurement moves content coordinates;
// only movement of the retained reading content tells us whether input was undone.
async function startUpwardReadingProbe(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript")!;
    type Row = { id: string; top: number; bottom: number };
    type Sample = { top: number; height: number; rows: Row[]; range: string };
    const result = {
      frames: 0,
      idleFrames: 0,
      progress: 0,
      idleGrowth: 0,
      errors: [] as unknown[],
      samples: [] as unknown[],
      ranges: 0,
    };
    const ranges = new Set<string>();
    let phase: "scrolling" | "idle" = "scrolling";
    let previous: Row | undefined;
    let pending: Sample | undefined;
    let idleHeight: number | undefined;
    let frame: number;
    let tall = false;
    const sentinel = document.createElement("div");
    sentinel.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;contain:strict;pointer-events:none";
    document.body.append(sentinel);
    const commit = () => {
      const sample = pending;
      pending = undefined;
      if (!sample) return;
      result.frames++;
      ranges.add(sample.range);
      result.ranges = ranges.size;
      if (phase === "idle") {
        result.idleFrames++;
        idleHeight ??= sample.height;
        result.idleGrowth = Math.max(result.idleGrowth, sample.height - idleHeight);
      }
      if (previous) {
        const retained = sample.rows.find((row) => row.id === previous!.id);
        const delta = retained ? retained.top - previous.top : "unmounted";
        if (delta === "unmounted" || (phase === "idle" ? Math.abs(delta) > 1 : delta < -1)) {
          if (result.errors.length < 12)
            result.errors.push({ phase, previous, retained, scrollTop: sample.top, delta });
        } else if (phase === "scrolling") result.progress += delta;
      }
      previous = sample.rows.find((row) => row.bottom > 1);
      result.samples.push({ phase, scrollTop: sample.top, anchor: previous, range: sample.range });
      if (result.samples.length > 12) result.samples.shift();
    };
    const observer = new ResizeObserver(() => {
      const viewportTop = scroller.getBoundingClientRect().top;
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].map(
        (row) => {
          const rect = row.getBoundingClientRect();
          return {
            id: row.dataset.transcriptAnchorId!,
            top: rect.top - viewportTop,
            bottom: rect.bottom - viewportTop,
          };
        },
      );
      pending = {
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        rows,
        range: `${rows[0]?.id}:${rows.at(-1)?.id}`,
      };
    });
    observer.observe(sentinel);
    observer.observe(scroller.firstElementChild!);
    const tick = () => {
      commit();
      tall = !tall;
      sentinel.style.height = tall ? "2px" : "1px";
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    Reflect.set(window, "upwardReadingProbe", {
      idle() {
        commit();
        phase = "idle";
        idleHeight = scroller.scrollHeight;
      },
      stop: () =>
        new Promise<typeof result>((resolve) =>
          requestAnimationFrame(() => {
            commit();
            cancelAnimationFrame(frame);
            observer.disconnect();
            sentinel.remove();
            resolve(result);
          }),
        ),
    });
  });
  // Establish a painted baseline before the next native gesture.
  await settle(page);
}

const idleReadingProbe = (page: Page) =>
  page.evaluate(() => {
    (Reflect.get(window, "upwardReadingProbe") as { idle(): void }).idle();
  });
const stopReadingProbe = (page: Page) =>
  page.evaluate(() =>
    (
      Reflect.get(window, "upwardReadingProbe") as {
        stop(): Promise<{
          frames: number;
          idleFrames: number;
          progress: number;
          idleGrowth: number;
          ranges: number;
          errors: unknown[];
          samples: unknown[];
        }>;
      }
    ).stop(),
  );

// The reader's own upward scroll is the only signal that matters. Nothing the
// transcript does in response to content may pull it back down.
test.describe("reader scrolling up while content streams", () => {
  test("a native upward scroll is kept when a commit lands before its scroll event", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    // A scroll over an iframe, a scrollbar drag or find-in-page moves the viewport
    // without any wheel/key/touch event in the transcript. A streaming commit can
    // reconcile layout before that movement's scroll event is dispatched.
    const result = await transcript.evaluate((element) => {
      const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
      element.scrollTop -= 120;
      const intended = element.scrollTop;
      fixture.stream();
      return { intended, actual: element.scrollTop };
    });
    expect(result.actual).toBe(result.intended);
    await settle(page);
    const savedTop = await top(transcript);
    const savedAnchor = await anchor(transcript);
    expect(await gap(transcript)).toBeGreaterThan(120);
    for (const operation of ["stream", "arrive", "activity"] as const) {
      await command(page, operation);
      await settle(page);
      expect(await top(transcript)).toBe(savedTop);
      expect(await anchor(transcript)).toEqual(savedAnchor);
    }
  });

  test("a native upward scroll is kept when content grew before its scroll event", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await settle(page);
    // Scroll events run before ResizeObservers in a frame, so the owner sees the
    // movement together with content growth it has not reconciled yet.
    const intended = await transcript.evaluate((element) => {
      element.scrollTop -= 120;
      const intended = element.scrollTop;
      const footer = [...element.querySelectorAll<HTMLElement>("div")].find((candidate) =>
        candidate.textContent?.startsWith("Activity revision"),
      )!;
      footer.style.paddingBottom = "200px";
      return intended;
    });
    await settle(page);
    expect(await top(transcript)).toBe(intended);
    const savedAnchor = await anchor(transcript);
    for (const operation of ["stream", "stream", "arrive"] as const) {
      await command(page, operation);
      await settle(page);
      expect(await top(transcript)).toBe(intended);
      expect(await anchor(transcript)).toEqual(savedAnchor);
    }
  });

  test("a one-pixel upward scroll away from the bottom is not undone", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    await settle(page);
    const intended = await transcript.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 1;
      return element.scrollTop;
    });
    await settle(page);
    expect(await top(transcript)).toBe(intended);
    for (let step = 0; step < 3; step++) {
      await command(page, "stream");
      await settle(page);
      expect(await top(transcript)).toBe(intended);
    }
  });

  for (const mode of ["text", "text+tool+arrive"] as const)
    test(`wheeling up during live ${mode} updates preserves painted reading progress`, async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      await transcript.hover({ position: { x: 300, y: 150 } });
      await live(page, mode);
      await page.waitForTimeout(400);
      // Following: a sample may land between a commit and its reconcile.
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
      await page.mouse.wheel(0, -40);
      await settle(page);
      expect(await gap(transcript)).toBeGreaterThanOrEqual(39);
      await startUpwardReadingProbe(page);
      for (let step = 0; step < 20; step++) {
        await page.mouse.wheel(0, -40);
        await page.waitForTimeout(16);
      }
      await settle(page);
      await idleReadingProbe(page);
      await command(page, "stream");
      await command(page, "stream");
      await command(page, "arrive");
      await settle(page);
      await page.waitForTimeout(300);
      await live(page, false);
      const reading = await stopReadingProbe(page);
      expect(reading.errors, JSON.stringify(reading)).toEqual([]);
      expect(reading.progress, JSON.stringify(reading)).toBeGreaterThanOrEqual(20 * 40 - 1);
      expect(reading.ranges).toBeGreaterThan(1);
      expect(reading.idleFrames).toBeGreaterThan(1);
      expect(reading.idleGrowth).toBeGreaterThan(0);
    });
});

test.describe("reader scrolling over an inline widget while content streams", () => {
  test.use({ withWidget: true });

  test("the first upward iframe gesture detaches and preserves painted reading progress", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const iframe = transcript.locator("iframe");
    await expect(transcript.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
    const bounds = (await iframe.boundingBox())!;
    const viewport = (await transcript.boundingBox())!;
    // Wheel events over the iframe belong to its document: the transcript sees
    // only the chained scroll, never the input.
    await page.mouse.move(bounds.x + bounds.width / 2, Math.max(viewport.y, bounds.y) + 30);
    await live(page, "text");
    await page.waitForTimeout(200);
    await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, -40);
    await settle(page);
    expect(await gap(transcript)).toBeGreaterThanOrEqual(39);
    await startUpwardReadingProbe(page);
    for (let step = 0; step < 9; step++) {
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(30);
    }
    await settle(page);
    await idleReadingProbe(page);
    await command(page, "stream");
    await command(page, "stream");
    await command(page, "arrive");
    await settle(page);
    await page.waitForTimeout(300);
    const finalGap = await gap(transcript);
    await live(page, false);
    const reading = await stopReadingProbe(page);
    expect(reading.errors, JSON.stringify(reading)).toEqual([]);
    expect(reading.progress, JSON.stringify(reading)).toBeGreaterThanOrEqual(9 * 40 - 1);
    expect(reading.ranges).toBeGreaterThan(1);
    expect(reading.idleFrames).toBeGreaterThan(1);
    expect(reading.idleGrowth).toBeGreaterThan(0);
    expect(finalGap).toBeGreaterThanOrEqual(10 * 40 - 1);
  });
});

test("a live arrival's entrance animation never shifts the reader's anchor", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  // Read with the newest message straddling the top edge, so the next arrival's
  // entrance transform is the nearest candidate for an anchor.
  await wheel(page, transcript, -120);
  const saved = await anchor(transcript);
  const offsets = await transcript.evaluate(async (element, id) => {
    const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
    fixture.arrive();
    const samples: number[] = [];
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const row = element.querySelector<HTMLElement>(`[data-transcript-anchor-id="${id}"]`)!;
      samples.push(row.getBoundingClientRect().top - element.getBoundingClientRect().top);
    }
    return samples;
  }, saved.id);
  expect(new Set(offsets)).toEqual(new Set([saved.offset]));
});

// Diagnosis-only regressions: assert the reader's visible CONTENT, not just the
// enclosing virtual row. Native Electron layout, image decode, ResizeObserver,
// Markdown, real Stores and the patched Virtuoso are all left intact.
const mediaMessageId = "message-25";
const readingText = "Reading marker after the media.";
const mediaRow = (page: Page) => page.locator(`[data-transcript-anchor-id="${mediaMessageId}"]`);
const readingMarker = (page: Page) => mediaRow(page).getByText(readingText, { exact: true });
const mediaParagraphs = Array.from(
  { length: 12 },
  (_, index) => `Context paragraph ${index}. ${"Reading context. ".repeat(12)}`,
).join("\n\n");
const tableMarkdown = [
  "| First column | Second column |",
  "| --- | --- |",
  ...Array.from(
    { length: 12 },
    (_, index) =>
      `| Cell ${index}. ${"Wrapping words. ".repeat(9)} | ${"More wrapping words. ".repeat(9)} |`,
  ),
].join("\n");

async function projectParts(page: Page, parts: UiPart[]) {
  await page.evaluate((updates) => {
    (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).partsUpdated(updates);
  }, parts);
}

async function projectMedia(page: Page, media: string) {
  await projectParts(page, [
    {
      kind: "text",
      id: mediaMessageId,
      role: "assistant",
      status: "complete",
      text: `${mediaParagraphs}\n\n${media}\n\n${readingText}\n\n${mediaParagraphs}`,
    },
  ]);
  await showMediaRow(page);
}

async function showMediaRow(page: Page) {
  // Home is a genuine reader destination; native scroll then moves through the
  // real virtual range. No measurement or application scroll API is mocked.
  const transcript = page.locator(".transcript");
  await transcript.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 35 && !(await mediaRow(page).count()); step++)
    await wheel(page, transcript, 300);
  await expect(mediaRow(page)).toHaveCount(1);
  await settle(page);
}

async function readMarkerAt(page: Page, offset = 120) {
  await readingMarker(page).evaluate((element, offset) => {
    const scroller = element.closest(".transcript")!;
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  }, offset);
  await settle(page);
  await expect(readingMarker(page)).toBeInViewport();
}

async function readingGeometry(page: Page) {
  return readingMarker(page).evaluate((element) => {
    const scroller = element.closest(".transcript")!;
    const row = element.closest<HTMLElement>("[data-transcript-item-key]")!;
    const viewport = scroller.getBoundingClientRect();
    return {
      marker: element.getBoundingClientRect().top - viewport.top,
      row: row.getBoundingClientRect().top - viewport.top,
      rowHeight: row.getBoundingClientRect().height,
      scrollTop: scroller.scrollTop,
      gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    };
  });
}

async function delayedMedia(page: Page, path = "late-image") {
  let release: (() => Promise<void>) | undefined;
  let released = false;
  await page.route(`https://transcript.invalid/${path}`, async (route) => {
    const finish = () =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"/>',
      });
    if (released) await finish();
    else release = finish;
  });
  return async () => {
    await expect.poll(() => Boolean(release)).toBe(true);
    released = true;
    await release!();
    await page
      .locator(".transcript img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
      );
    await settle(page);
  };
}

test.describe("media content anchoring diagnosis", () => {
  test("large late image in an earlier row holds the following reading row", async ({
    fixturePage: page,
  }) => {
    const release = await delayedMedia(page);
    await projectMedia(page, "![Delayed diagram](https://transcript.invalid/late-image)");
    const next = page.locator('[data-transcript-anchor-id="message-26"]');
    // Read the next message while the tall media row is still in top overscan.
    await mediaRow(page).evaluate((row) => {
      const scroller = row.closest(".transcript")!;
      scroller.scrollTop +=
        row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 8;
    });
    await settle(page);
    await expect(next).toBeInViewport();
    const offset = () =>
      next.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest(".transcript")!.getBoundingClientRect().top,
      );
    const before = await offset();
    expect(
      await mediaRow(page)
        .locator("img")
        .evaluate(
          (image) =>
            image.getBoundingClientRect().top -
            image.closest(".transcript")!.getBoundingClientRect().top,
        ),
    ).toBeLessThan(0);
    await release();
    const after = await page.locator(".transcript").evaluate((element) => ({
      top: element.scrollTop,
      rows: [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].map(
        (row) => ({
          id: row.dataset.transcriptAnchorId,
          top: row.getBoundingClientRect().top - element.getBoundingClientRect().top,
        }),
      ),
    }));
    await expect(next, JSON.stringify({ before, after })).toBeInViewport();
    expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(1);
    const saved = await anchor(page.locator(".transcript"));
    await command(page, "stream");
    await command(page, "arrive");
    await settle(page);
    expect(await anchor(page.locator(".transcript"))).toEqual(saved);
  });
  for (const offset of [12, 200]) {
    test(`late image inside the reading row preserves visible prose at offset ${offset}`, async ({
      fixturePage: page,
    }) => {
      const release = await delayedMedia(page);
      await projectMedia(page, "![Delayed diagram](https://transcript.invalid/late-image)");
      await readMarkerAt(page, offset);
      const before = await readingGeometry(page);
      const imageTop = await mediaRow(page)
        .locator("img")
        .evaluate(
          (image) =>
            image.getBoundingClientRect().top -
            image.closest(".transcript")!.getBoundingClientRect().top,
        );
      expect(offset === 12 ? imageTop < 0 : imageTop > 0).toBe(true);
      await release();
      const after = await readingGeometry(page);
      expect(after.rowHeight - before.rowHeight).toBeGreaterThan(500);
      expect(
        Math.abs(after.marker - before.marker),
        JSON.stringify({ before, after, imageTop }),
      ).toBeLessThanOrEqual(1);
    });
  }

  for (const following of [false, true]) {
    test(`rewrapping a ${following ? "top-crossing paragraph before another visible block" : "viewport-filling paragraph"} holds its visible text character`, async ({
      fixturePage: page,
    }) => {
      await projectParts(page, [
        {
          kind: "text",
          id: mediaMessageId,
          role: "assistant",
          status: "complete",
          text:
            "Long paragraph reading content. ".repeat(500) +
            (following ? "\n\nFollowing paragraph." : ""),
        },
      ]);
      await showMediaRow(page);
      const paragraph = mediaRow(page).locator("p").first();
      await paragraph.evaluate((element, following) => {
        const range = document.createRange();
        const offset = following ? element.textContent!.length - 250 : 1_500;
        range.setStart(element.firstChild!, offset);
        range.setEnd(element.firstChild!, offset + 1);
        const scroller = element.closest(".transcript")!;
        scroller.scrollTop +=
          range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
      }, following);
      await settle(page);
      if (following)
        await expect(
          mediaRow(page).getByText("Following paragraph.", { exact: true }),
        ).toBeInViewport();
      const before = await paragraph.evaluate((element) => {
        const viewport = element.closest(".transcript")!.getBoundingClientRect();
        const caret = document.caretRangeFromPoint(
          element.getBoundingClientRect().left + 1,
          viewport.top + 1,
        )!;
        const range = document.createRange();
        range.setStart(caret.startContainer, caret.startOffset);
        range.setEnd(caret.startContainer, caret.startOffset + 1);
        return { offset: caret.startOffset, top: range.getBoundingClientRect().top - viewport.top };
      });
      await page.locator("#root").evaluate((root) => {
        root.style.width = "440px";
      });
      await settle(page);
      const after = await paragraph.evaluate((element, offset) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, offset);
        range.setEnd(element.firstChild!, offset + 1);
        return (
          range.getBoundingClientRect().top -
          element.closest(".transcript")!.getBoundingClientRect().top
        );
      }, before.offset);
      expect(Math.abs(after - before.top), JSON.stringify({ before, after })).toBeLessThanOrEqual(
        1,
      );
    });
  }

  test("table rewrapping keeps the visible prose below it fixed", async ({ fixturePage: page }) => {
    await projectMedia(page, tableMarkdown);
    await readMarkerAt(page);
    const before = await readingGeometry(page);
    const tableBefore = await mediaRow(page)
      .locator("table")
      .evaluate((table) => table.getBoundingClientRect().height);
    // A split-pane/window width change, not a made-up row height.
    await page.locator("#root").evaluate((root) => {
      root.style.width = "440px";
    });
    await settle(page);
    const tableAfter = await mediaRow(page)
      .locator("table")
      .evaluate((table) => table.getBoundingClientRect().height);
    const after = await readingGeometry(page);
    expect(tableAfter - tableBefore).toBeGreaterThan(100);
    expect(
      Math.abs(after.marker - before.marker),
      JSON.stringify({ before, after, tableBefore, tableAfter }),
    ).toBeLessThanOrEqual(1);
  });

  for (const placement of ["above", "inside", "bottom"] as const) {
    test(`vaulted portrait attachment loading and dimension changes ${placement} the viewport`, async ({
      fixturePage: page,
    }) => {
      const transcript = page.locator(".transcript");
      const reference = {
        kind: "input" as const,
        id: "20000000-0000-4000-8000-000000000001",
        name: "portrait.png",
        mimeType: "image/png",
        byteLength: 1000,
      };
      const part: UiPart = {
        kind: "attachment",
        id: mediaMessageId,
        attachmentKind: "image",
        mediaType: "image/png",
        name: reference.name,
        inputReference: reference,
      };
      await projectParts(page, [placement === "bottom" ? { ...part, id: "last-image" } : part]);
      if (placement !== "bottom") {
        await showMediaRow(page);
        await mediaRow(page).evaluate((row, placement) => {
          const scroller = row.closest(".transcript")!;
          const rect = row.getBoundingClientRect();
          scroller.scrollTop +=
            (placement === "above" ? rect.bottom : rect.top) -
            scroller.getBoundingClientRect().top -
            (placement === "above" ? -8 : 100);
        }, placement);
      }
      await settle(page);
      const figure = transcript.locator("figure");
      await expect(figure).toHaveCount(1);
      const height = () => figure.evaluate((element) => element.getBoundingClientRect().height);
      const before = { height: await height(), anchor: await anchor(transcript) };
      const data = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 1800;
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      await page.evaluate(
        ({ data, reference }) => {
          (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).loadAttachment({
            kind: "image",
            mimeType: "image/png",
            data,
            reference,
          });
        },
        { data, reference },
      );
      await expect(figure.locator("img")).toHaveCount(1);
      await figure.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      await settle(page);
      const loaded = {
        height: await height(),
        anchor: await anchor(transcript),
        gap: await gap(transcript),
      };
      expect
        .soft(Math.abs(loaded.height - before.height), JSON.stringify({ before, loaded }))
        .toBeLessThanOrEqual(1);
      if (placement === "bottom") expect.soft(loaded.gap).toBeLessThanOrEqual(1);
      else expect.soft(loaded.anchor).toEqual(before.anchor);
      // The same visible attachment reconciles to pixels of a different aspect.
      const wide = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 1800;
        canvas.height = 300;
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      await projectParts(page, [
        { ...part, id: placement === "bottom" ? "last-image" : part.id, data: wide },
      ]);
      await figure.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      await settle(page);
      expect(Math.abs((await height()) - before.height)).toBeLessThanOrEqual(1);
      if (placement === "bottom") {
        await command(page, "stream");
        await settle(page);
        expect(await gap(transcript)).toBeLessThanOrEqual(1);
      } else {
        expect(await anchor(transcript)).toEqual(before.anchor);
        await command(page, "stream");
        await settle(page);
        expect(await anchor(transcript)).toEqual(before.anchor);
      }
    });
  }

  test("bottom pin follows late Markdown image and streamed table growth", async ({
    fixturePage: page,
  }) => {
    const transcript = page.locator(".transcript");
    const release = await delayedMedia(page);
    const part: UiPart = {
      kind: "text",
      id: "streaming-media",
      role: "assistant",
      status: "streaming",
      text: "![Delayed diagram](https://transcript.invalid/late-image)",
    };
    await projectParts(page, [part]);
    await settle(page);
    expect(await gap(transcript)).toBeLessThanOrEqual(1);
    await release();
    expect(await gap(transcript)).toBeLessThanOrEqual(1);
    for (let rows = 3; rows <= 12; rows += 3) {
      await projectParts(page, [
        {
          ...part,
          text: `${part.text}\n\n${tableMarkdown
            .split("\n")
            .slice(0, rows + 2)
            .join("\n")}`,
        },
      ]);
      await settle(page);
      expect(await gap(transcript)).toBeLessThanOrEqual(1);
    }
    await page.locator("#root").evaluate((root) => {
      root.style.width = "440px";
    });
    await settle(page);
    expect(await gap(transcript)).toBeLessThanOrEqual(1);
  });

  for (const media of ["image", "table"] as const) {
    test(`${media} remount restores the same visible prose`, async ({ fixturePage: page }) => {
      const release = await delayedMedia(page);
      await projectMedia(
        page,
        media === "image"
          ? "![Delayed diagram](https://transcript.invalid/late-image)"
          : tableMarkdown,
      );
      if (media === "image") await release();
      await readMarkerAt(page);
      const before = await readingGeometry(page);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture
            ).readingPosition(),
          ),
        )
        .toMatchObject({ kind: "message", messageId: mediaMessageId });
      const saved = await page.evaluate(() =>
        (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).readingPosition(),
      );
      const remountTrace = await page.evaluate(async () => {
        const probes = new Set<string>();
        const observer = new MutationObserver((records) => {
          for (const record of records)
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
              if (!(node instanceof HTMLElement)) continue;
              const rows = [...node.querySelectorAll<HTMLElement>("[data-transcript-item-index]")];
              if (node.matches("[data-transcript-item-index]")) rows.push(node);
              for (const row of rows) {
                const index = row.dataset.transcriptItemIndex;
                const id = row.dataset.transcriptAnchorId;
                if (id !== `message-${index}`) probes.add(`index ${index} rendered ${id}`);
              }
            }
        });
        observer.observe(document.getElementById("root")!, { subtree: true, childList: true });
        (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).remount();
        const samples: unknown[] = [];
        let previous = "";
        for (let frame = 0; frame < 12; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          const scroller = document.querySelector<HTMLElement>(".transcript")!;
          const list = scroller.querySelector<HTMLElement>('[aria-label="Conversation"]')!;
          const sample = {
            top: scroller.scrollTop,
            visibility: getComputedStyle(list).visibility,
            rows: [...scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].map(
              (row) => row.dataset.transcriptAnchorId,
            ),
            mediaHeight: scroller
              .querySelector('[data-transcript-anchor-id="message-25"]')
              ?.getBoundingClientRect().height,
            padding: list.style.paddingTop,
          };
          if (JSON.stringify(sample) !== previous) samples.push(sample);
          previous = JSON.stringify(sample);
        }
        observer.disconnect();
        return { samples, probes: [...probes] };
      });
      expect(remountTrace.probes).toEqual([]);
      await expect(page.locator('[aria-label="Conversation"]')).toBeVisible();
      await settle(page);
      const restored = await page.locator(".transcript").evaluate((element) => ({
        top: element.scrollTop,
        gap: element.scrollHeight - element.clientHeight - element.scrollTop,
        rows: [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")].map(
          (row) => row.dataset.transcriptAnchorId,
        ),
      }));
      await expect(
        readingMarker(page),
        JSON.stringify({ before, saved, restored, remountTrace }),
      ).toHaveCount(1);
      await mediaRow(page)
        .locator("img")
        .evaluateAll((images) =>
          Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
        );
      await settle(page);
      const after = await readingGeometry(page);
      expect(
        Math.abs(after.marker - before.marker),
        JSON.stringify({ before, after }),
      ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("viewport-aware message actions", () => {
  test.use({ messageCount: 2, chatMode: "full" });
  test("keeps one external toolbar through boundary transitions and hides a cramped side rail", async ({
    fixturePage: page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.evaluate(() => {
      (Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture).partsUpdated([
        {
          kind: "text",
          id: "before",
          role: "user",
          status: "complete",
          text: "Earlier message. ".repeat(150),
        },
        {
          kind: "text",
          id: "target",
          role: "assistant",
          status: "complete",
          text: "Viewport action body\n\n" + "Long paragraph.\n\n".repeat(100),
        },
        {
          kind: "text",
          id: "after",
          role: "user",
          status: "complete",
          text: "Later message. ".repeat(150),
        },
      ]);
    });
    const message = page
      .locator('[data-slot="message"]')
      .filter({ hasText: "Viewport action body" });
    const toolbar = message.locator('[data-slot="message-action-toolbar"]');
    const copy = toolbar.locator('button[aria-label="Copy response"]');
    await expect(toolbar).toHaveCount(1);
    await copy.evaluate((button) => {
      button.dataset.identity = "original";
    });
    const scrollTo = async (boundary: "top" | "middle" | "bottom" | "offscreen") => {
      await message.evaluate((node, boundary) => {
        const scroller = node.closest<HTMLElement>(".transcript")!;
        const viewport = scroller.getBoundingClientRect();
        const body = node.querySelector('[data-slot="message-content"]')!.getBoundingClientRect();
        const delta =
          boundary === "top"
            ? body.top - viewport.top - 64
            : boundary === "middle"
              ? body.top - viewport.top + 250
              : boundary === "bottom"
                ? body.bottom - viewport.bottom + 64
                : body.bottom - viewport.top + 100;
        scroller.scrollTop += delta;
      }, boundary);
    };
    const assertExternal = async (kind: "above" | "side" | "footer") => {
      await expect(toolbar).toHaveAttribute("data-placement", kind);
      const geometry = await toolbar.evaluate((node) => {
        const actions = node.getBoundingClientRect();
        const article = node.closest("article")!;
        const body = article
          .querySelector('[data-slot="message-content"]')!
          .getBoundingClientRect();
        const viewport = article.closest(".transcript")!.getBoundingClientRect();
        return {
          external:
            actions.bottom <= body.top ||
            actions.top >= body.bottom ||
            actions.right <= body.left ||
            actions.left >= body.right,
          contained:
            actions.left >= viewport.left &&
            actions.right <= viewport.right &&
            actions.top >= viewport.top &&
            actions.bottom <= viewport.bottom,
        };
      });
      expect(geometry).toEqual({ external: true, contained: true });
      await expect(copy).toHaveAttribute("data-identity", "original");
      await expect(toolbar.getByRole("button")).toHaveCount(1);
    };
    await scrollTo("top");
    await assertExternal("above");
    await copy.focus();
    await expect(copy).toBeFocused();
    await scrollTo("middle");
    await assertExternal("side");
    await expect(copy).toBeFocused();
    // Resize only the chat pane, not the window: window-wide space is irrelevant.
    await page.locator("#root").evaluate((node) => {
      node.style.width = "400px";
    });
    await expect(toolbar).toHaveAttribute("data-placement", "hidden");
    await expect(copy).toBeHidden();
    await expect(toolbar).toHaveAttribute("inert", "");
    await page.locator("#root").evaluate((node) => {
      node.style.width = "100%";
    });
    await assertExternal("side");
    await scrollTo("bottom");
    await assertExternal("footer");
    await copy.focus();
    await copy.press("Enter");
    await expect(toolbar.getByRole("button", { name: "Copied response" })).toBeVisible();
    await scrollTo("offscreen");
    await expect(toolbar).toHaveAttribute("data-placement", "hidden");
    await expect(toolbar.getByRole("button")).toHaveCount(0);
  });
});
