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
}>({
  withWidget: [false, { option: true }],
  messageCount: [48, { option: true }],
  chatMode: ["", { option: true }],
  fixturePage: async ({ messageCount, chatMode, withWidget }, use) => {
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
        async ({ BrowserWindow }, { html, messageCount, chatMode, widget }) => {
          const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
          await window.loadFile(html, {
            search: `?count=${messageCount}&chatMode=${chatMode}&widget=${encodeURIComponent(JSON.stringify(widget))}`,
          });
        },
        { html, messageCount, chatMode, widget },
      );
      const page = await opened;
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const transcript = page.locator(".transcript");
      await expect(transcript.locator('[data-slot="transcript-item"]').last()).toContainText(
        `Message ${messageCount - 1}`,
      );
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
const command = (page: Page, operation: keyof TranscriptOwnershipFixture) =>
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
      return {
        before,
        intended,
        intendedAnchor,
        actual: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
      };
    }, step);
    expect(result.actual, JSON.stringify(result)).toBe(result.intended);
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

test("touch inertia owns scrolling and insertion cannot interrupt it", async ({
  fixturePage: page,
}) => {
  const transcript = page.locator(".transcript");
  const result = await transcript.evaluate((element) => {
    const fixture = Reflect.get(window, "transcriptFixture") as TranscriptOwnershipFixture;
    const touch = (clientY: number) => new Touch({ identifier: 1, target: element, clientY });
    element.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(200)], bubbles: true }));
    element.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(260)], bubbles: true }));
    element.scrollTop -= 120;
    const intended = element.scrollTop;
    fixture.stream();
    element.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
    fixture.insert(); // Finger released, but native inertia has not ended.
    return { intended, actual: element.scrollTop };
  });
  expect(result.actual).toBe(result.intended);
  await expect.poll(() => top(transcript)).toBe(result.intended);
  const saved = await anchor(transcript);
  await command(page, "activity");
  await expect.poll(() => anchor(transcript)).toEqual(saved);
  await command(page, "jump");
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
    test("pauses streaming follow until Down past the newest message", async ({
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
      await composer.press("ArrowDown");
      await expect(selected).toHaveCount(0);
      await expect(composer).toBeFocused();
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
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
    await command(page, "jump");
    for (let step = 0; step < 4; step++) {
      await command(page, "stream");
      await expect.poll(() => gap(transcript)).toBeLessThanOrEqual(1);
    }
  });
});

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
    const saved = await anchor(transcript);
    for (let step = 0; step < 4; step++) {
      await command(page, "stream");
      await expect.poll(() => anchor(transcript)).toEqual(saved);
    }
  });
});
