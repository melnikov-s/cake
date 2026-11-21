import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, Schema } from "effect";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario, seedArtifact } from "../../scripts/visual-capture/scenarios";
import { ApplicationState as ApplicationStateData } from "../../src/contracts/application/application-data";
import { TaskInputStorage } from "../../src/services/storage/TaskInputStorage";
import { makeTaskInputStorageLive } from "../../src/services/storage/TaskInputStorageLive";
import { makeProjectCanvasStorageLive } from "../../src/services/storage/ProjectCanvasStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { projectChatSessionId } from "../../src/domain/cake-chats/cakeChatLocations";
import {
  createProjectCanvasOperations,
  makeProjectCanvasControl,
} from "../../src/domain/project-canvas/project-canvas-operations";
import type * as canvas from "../../src/domain/project-canvas/projectCanvas";
import {
  CanvasDetail,
  type CanvasPublish,
} from "../../src/contracts/project-canvas/project-canvas";
import { fakeApplicationState } from "../helpers/fakes/applicationState";
import { fakeSessionFamilyStorage } from "../helpers/fakes/sessionFamilyStorage";
import { showTodos } from "./fixtures/workspace-navigation";
import { restoreClipboardSnapshot, saveClipboardSnapshot } from "./clipboard-harness";

const repo = resolve(import.meta.dirname, "../..");
const label = "Project Canvas";

/** Source pixels are screenshots of a local checkout fixture, not images copied from Rounds. */
async function checkoutScreens() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const render = async (after: boolean) => {
      await page.setContent(
        `<body style="margin:0;background:#f4f5f7;color:#19283c;font:18px -apple-system,sans-serif"><header style="padding:24px 60px;background:white;border-bottom:1px solid #e0e5eb;font-weight:700">FIELDWORK <span style="float:right;font-weight:normal">Bag / Checkout</span></header><main style="display:grid;grid-template-columns:1.3fr 1fr;gap:30px;padding:36px 60px"><section><small>STEP 1 OF 3</small><h1>Checkout</h1><p>${after ? "Check out as a guest" : "Sign in to continue"}</p><div style="background:white;border:1px solid #d4dae2;padding:16px;border-radius:8px;color:#626e7e">Email address</div><p style="background:${after ? "#36556c" : "#4e5969"};color:white;border-radius:8px;text-align:center;padding:16px">${after ? "Continue as guest" : "Sign in"}</p><p style="color:#626e7e">${after ? "Already have an account? Sign in" : "Create an account"}</p></section><aside style="background:white;border-radius:12px;padding:24px"><h2>Order summary</h2><div style="background:#e2e8dd;border-radius:6px;padding:22px">Trail kit · Moss</div><p>Subtotal <span style="float:right">$58.00</span></p><p>Shipping <span style="float:right">$6.00</span></p><hr><strong>Total <span style="float:right">$64.00</span></strong></aside></main></body>`,
      );
      return (await page.screenshot()).toString("base64");
    };
    return [await render(false), await render(true)] as const;
  } finally {
    await browser.close();
  }
}

test("Project Chat Canvas: published screenshots, exact link, pinned review, isolation and restart", async () => {
  const info = test.info();
  test.setTimeout(110_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-project-canvas-"));
  const paths = {
    cakeHome: join(directory, "cake"),
    project: join(directory, "project"),
    userData: join(directory, "user-data"),
  };
  const other = join(directory, "other");
  const scenario = findVisualCaptureScenario("cake-chat")!;
  await scenario.seed(paths, "light");
  await mkdir(other, { recursive: true });
  const state = join(paths.cakeHome, "state");
  const application = join(state, "application.json");
  const original = JSON.parse(await readFile(application, "utf8"));
  const data = Schema.decodeUnknownSync(ApplicationStateData)(original.data);
  const project = data.projects.find((item) => item.path === paths.project)!;
  const now = new Date().toISOString();
  const projects = [
    { ...project, name: "Fieldwork" },
    { path: other, name: "Empty project", addedAt: now, lastOpenedAt: now },
  ];
  const id = projectChatSessionId(project.path);
  const screenshots = await checkoutScreens();
  const artifact = {
    protocol: "cake.artifact/v1",
    id: "checkout-prototype",
    sessionId: id,
    revision: 1,
    kind: "html",
    title: "Checkout prototype",
    payload: { html: "<h1>Original checkout artifact</h1>" },
    fallback: { markdown: "Checkout prototype" },
  } as const;
  await seedArtifact(paths, artifact, now);
  const resources = Layer.mergeAll(
    fakeApplicationState({}, { ...data, projects }),
    makeArtifactStorageLive(join(state, "artifacts")).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    ),
    fakeSessionFamilyStorage(),
    makeTaskInputStorageLive(state),
    makeProjectCanvasStorageLive(state).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    ),
  );
  const seed = await Effect.runPromise(
    Effect.gen(function* () {
      const inputs = yield* TaskInputStorage;
      const refs = yield* inputs.isolate(
        id,
        screenshots.map((data, index) => ({
          kind: "image",
          data,
          mimeType: "image/png",
          name: `checkout-${index + 1}.png`,
        })),
      );
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof canvas.publish>>>();
      const operations = createProjectCanvasOperations(
        makeProjectCanvasControl(id, id, Effect.runPromiseWith(context)),
      );
      const tool = operations.find((item) => item.command === "canvas.publish")!;
      const publish = (input: CanvasPublish) =>
        Effect.tryPromise({
          try: (signal) => tool.execute(input, { signal, toolCallId: crypto.randomUUID() }),
          catch: (error) => new Error(String(error)),
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CanvasDetail)));
      const group = "Guest checkout · review";
      const before = yield* publish({
        group,
        title: "Before · account gate",
        content: { kind: "screenshot", attachmentId: refs[0]!.id },
      });
      yield* publish({
        group,
        title: "After · guest checkout",
        previous: before.link,
        content: { kind: "screenshot", attachmentId: refs[1]!.id },
      });
      yield* publish({
        group,
        title: "Before · reference",
        content: { kind: "screenshot", attachmentId: refs[0]!.id },
      });
      yield* publish({
        group,
        title: "Guest checkout decision",
        content: {
          kind: "decision",
          text: "Let guests check out without creating an account. Offer sign-in as a second path, not a gate.",
        },
        aspect: 1.25,
      });
      yield* publish({
        group: "Prototype",
        title: artifact.title,
        content: {
          kind: "artifact",
          reference: `cake://artifact/${artifact.id}`,
          previewAttachmentId: refs[1]!.id,
        },
      });
      return before;
    }).pipe(Effect.provide(resources)),
  );
  await seedArtifact(
    paths,
    { ...artifact, revision: 2, payload: { html: "<h1>Updated checkout artifact</h1>" } },
    now,
  );
  await writeFile(
    application,
    JSON.stringify({
      ...original,
      data: {
        ...data,
        projects: projects.map((entry) =>
          entry.path !== project.path
            ? entry
            : {
                ...entry,
                todos: {
                  sequence: 0,
                  deliveryToken: null,
                  selectedId: null,
                  pending: [],
                  items: [
                    {
                      id: crypto.randomUUID(),
                      title: "Review checkout",
                      description: "Check the original",
                      status: "",
                      revision: 0,
                      state: "open",
                      associations: [
                        { kind: "source", title: "Open original Canvas revision", ref: seed.link },
                      ],
                    },
                  ],
                },
              },
        ),
      },
    }),
  );
  const launch = () =>
    electron.launch({
      args: [repo],
      cwd: repo,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 980 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const select = (name: string) =>
      page.getByRole("button", { name: `Open Project Chat for ${name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await select("Empty project");
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("Nothing on the Canvas yet")).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-empty.png") });
    await select("Fieldwork");
    await page.getByRole("button", { name: label, exact: true }).click();
    const board = page.getByLabel("Canvas board", { exact: true });
    const world = board.getByTestId("canvas-world");
    await expect(world.getByRole("img", { name: "After · guest checkout" })).toBeVisible();
    await expect(world.getByRole("img", { name: "Checkout prototype" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-overview.png") });
    const bounds = (await board.boundingBox())!;
    const point = { x: bounds.x + bounds.width * 0.7, y: bounds.y + 36 };
    const transform = () =>
      world.evaluate((el) => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return { x: m.e, y: m.f, scale: m.a };
      });
    const start = await transform();
    // Chromium can send multiple wheel events for one OS-level gesture. Measure the actual
    // deltas delivered to the board, then verify their pixel-for-pixel effect.
    const delivered = await board.evaluateHandle((el) => {
      const total = { x: 0, y: 0 };
      el.addEventListener("wheel", (event) => {
        if (!event.ctrlKey && !event.metaKey) {
          total.x += event.deltaX;
          total.y += event.deltaY;
        }
      });
      return total;
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(34, 50);
    await expect.poll(async () => (await delivered.jsonValue()).y).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const [delta, current] = await Promise.all([delivered.jsonValue(), transform()]);
        return (
          Math.abs(current.y - (start.y - delta.y)) + Math.abs(current.x - (start.x - delta.x))
        );
      })
      .toBeLessThan(0.25);
    await delivered.dispose();
    const panned = await transform();
    await page.mouse.move(bounds.x + bounds.width - 18, bounds.y + 24);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 88, bounds.y + 84, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await transform()).x).toBeCloseTo(panned.x - 70, 0);
    await page.mouse.move(point.x, point.y);
    const cursor = await board.evaluateHandle((el) => {
      const local = { x: 0, y: 0 };
      el.addEventListener(
        "wheel",
        (event) => {
          const rect = el.getBoundingClientRect();
          local.x = event.clientX - rect.left;
          local.y = event.clientY - rect.top;
        },
        { once: true },
      );
      return local;
    });
    const beforeZoom = await transform();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -30);
    await page.keyboard.up("Control");
    await expect.poll(async () => (await transform()).scale).toBeGreaterThan(beforeZoom.scale);
    const zoomed = await transform();
    const local = await cursor.jsonValue();
    await cursor.dispose();
    expect((local.x - zoomed.x) / zoomed.scale).toBeCloseTo(
      (local.x - beforeZoom.x) / beforeZoom.scale,
      2,
    );
    expect((local.y - zoomed.y) / zoomed.scale).toBeCloseTo(
      (local.y - beforeZoom.y) / beforeZoom.scale,
      2,
    );
    await page.getByRole("button", { name: "Fit board" }).click();
    await expect.poll(transform).toEqual(start);
    await world.getByRole("button", { name: "Review Checkout prototype" }).click();
    await page.getByRole("button", { name: "Open artifact", exact: true }).click();
    await expect(
      page
        .frameLocator('iframe[title="Checkout prototype"]')
        .getByText("Original checkout artifact"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Exit fullscreen Checkout prototype", exact: true })
      .click();
    await page.getByRole("button", { name: "Fit board" }).click();
    await page.getByRole("button", { name: "Search Canvas" }).click();
    await page.getByRole("textbox", { name: "Search cards" }).fill("account gate");
    await page.getByRole("textbox", { name: "Search cards" }).press("Enter");
    const stage = page.getByRole("dialog", { name: "Review Before · account gate" });
    await expect(stage.getByRole("img", { name: "Before · account gate" })).toBeVisible();
    await stage.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(stage.getByRole("img", { name: "After · guest checkout" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-compare.png") });
    await saveClipboardSnapshot(app, "canvas-smoke-clipboard");
    try {
      await stage.getByRole("button", { name: "Copy link", exact: true }).click();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(seed.link);
    } finally {
      await restoreClipboardSnapshot(app, "canvas-smoke-clipboard");
    }
    await stage.getByRole("button", { name: "Pin feedback", exact: true }).click();
    await stage
      .getByRole("button", { name: "Place feedback on this revision" })
      .click({ position: { x: 100, y: 100 } });
    await stage.getByRole("textbox", { name: "Pinned feedback" }).fill("Keep this path visible.");
    await stage.getByRole("button", { name: "Save pin" }).click();
    await stage.getByRole("button", { name: "Feedback pin 1" }).click();
    await expect(stage.getByText("Keep this path visible.")).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-pin.png") });
    await stage.getByRole("button", { name: "Draft reply to publisher" }).click();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toContainText(
      seed.link,
    );
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 980 });
    await select("Fieldwork");
    await showTodos(page);
    await page.getByRole("button", { name: "Show 1 link for Review checkout" }).click();
    await page.getByRole("link", { name: "Open original Canvas revision" }).click();
    const reopened = page.getByRole("dialog", { name: "Review Before · account gate" });
    await expect(reopened.getByRole("img", { name: "Before · account gate" })).toBeVisible();
    await reopened.getByRole("button", { name: "Feedback pin 1" }).click();
    await expect(reopened.getByText("Keep this path visible.")).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
