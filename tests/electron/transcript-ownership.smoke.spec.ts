import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  _electron as electron,
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";
import type { TranscriptOwnershipFixture } from "./transcript-ownership-fixture";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";
import type { CompiledInlineWidget } from "../../src/contracts/widgets/inline-widget-contract";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const test = base.extend<{
  fixturePage: Page;
  messageCount: number;
  chatMode: string;
  withWidget: boolean;
  withUpdates: boolean;
}>({
  withUpdates: [false, { option: true }],
  withWidget: [false, { option: true }],
  messageCount: [48, { option: true }],
  chatMode: ["", { option: true }],
  fixturePage: async ({ messageCount, chatMode, withWidget, withUpdates }, use) => {
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
      const opened = application.waitForEvent("window");
      await application.evaluate(
        async ({ BrowserWindow }, { html, messageCount, chatMode, widget, withUpdates }) => {
          // Match the application window: a hidden window must not throttle
          // animation frames, or Virtuoso never finishes initial positioning.
          const window = new BrowserWindow({
            show: false,
            webPreferences: { sandbox: true, backgroundThrottling: false },
          });
          await window.loadFile(html, {
            search: `?count=${messageCount}&chatMode=${chatMode}&updates=${withUpdates}&widget=${encodeURIComponent(JSON.stringify(widget))}`,
          });
        },
        { html, messageCount, chatMode, widget, withUpdates },
      );
      const page = await opened;
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
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
  await disclosure.click();
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
    const row = [...element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]')].find(
      (row) => row.getBoundingClientRect().bottom <= viewportTop,
    )!;
    const image = document.createElement("img");
    row.append(image);
    image.src =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="180"/>';
    await image.decode();
  });
  await expect.poll(() => anchor(transcript)).toEqual(saved);
  await disclosure.click();
  await expect(activity).not.toHaveAttribute("open");
  await expect.poll(() => anchor(transcript)).toEqual(saved);
});

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

test.describe("inline widget reading position", () => {
  test.use({ withWidget: true });

  test("scrolling over the widget pauses outer bottom following", async ({ fixturePage: page }) => {
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
          if (original) {
            // A wheel inside the bounded original scrolls its body, not the chat.
            const bounds = await body.boundingBox();
            await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
            await page.mouse.wheel(0, 180);
            await expect
              .poll(() => body.evaluate((element) => element.scrollTop))
              .toBeGreaterThan(0);
            await expectHeld(trigger, saved);
          } else {
            const before = await top(transcript);
            await wheel(page, transcript, 180);
            await expect.poll(() => top(transcript)).toBeGreaterThan(before + 100);
          }
          await trigger.scrollIntoViewIfNeeded();
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
          const reopened = await offset(trigger);
          // Keyboard activation must pause following too, and reopening starts at the top.
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
    test(`wheeling up during live ${mode} updates detaches at once and never moves back down`, async ({
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
      const tops = [await top(transcript)];
      expect(await gap(transcript)).toBeGreaterThanOrEqual(39);
      for (let step = 0; step < 20; step++) {
        await page.mouse.wheel(0, -40);
        await page.waitForTimeout(16);
        tops.push(await top(transcript));
      }
      await page.waitForTimeout(300);
      tops.push(await top(transcript));
      await live(page, false);
      const downward = tops.slice(1).filter((value, index) => value > tops[index]!);
      expect(downward, JSON.stringify(tops)).toEqual([]);
      expect(tops[0]! - tops.at(-1)!).toBeGreaterThanOrEqual(20 * 40 - 1);
    });
});

test.describe("reader scrolling over an inline widget while content streams", () => {
  test.use({ withWidget: true });

  test("the first upward gesture over the iframe detaches and is never undone", async ({
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
    const tops: number[] = [];
    for (let step = 0; step < 10; step++) {
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(30);
      tops.push(await top(transcript));
    }
    const finalGap = await gap(transcript);
    await live(page, false);
    const downward = tops.slice(1).filter((value, index) => value > tops[index]!);
    expect(downward, JSON.stringify(tops)).toEqual([]);
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
