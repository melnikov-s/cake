import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { decodeArtifactLineageId } from "../../src/contracts/artifacts/artifact-lineage";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("initial A remains immutable while exact-r3 live C pixels and advisory state attach without sending", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-widget-view-evidence-"));
  const paths = (name: string) => ({
    cakeHome: join(root, name, "cake-home"),
    project: join(root, name, "project"),
    userData: join(root, name, "user-data"),
  });
  const scenario = findVisualCaptureScenario("widget-view-evidence")!;
  const launch = (fixture: ReturnType<typeof paths>) =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: fixture.userData,
        CAKE_HOME: fixture.cakeHome,
        PI_CODING_AGENT_DIR: join(fixture.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  const baseline = paths("baseline");
  const current = paths("current");
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  const storageRuntime = ManagedRuntime.make(
    makeArtifactStorageLive(join(baseline.cakeHome, "state", "artifacts")).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    ),
  );
  try {
    await scenario.seed(baseline, "light");
    app = await launch(baseline);
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
    );
    await scenario.prepare(page, "initial");
    const initialPng = await page
      .getByRole("dialog", { name: "Widget view evidence", exact: true })
      .locator("iframe")
      .screenshot();
    await app.close();
    app = undefined;
    const original = await storageRuntime.runPromise(
      Effect.flatMap(ArtifactStorage, (storage) =>
        storage.read(decodeArtifactLineageId("widget-view-evidence")),
      ),
    );
    if (original?.snapshot.kind !== "widget") throw new Error("Missing baseline widget");
    await scenario.seed(current, "light", {
      ...original.snapshot,
      payload: {
        ...original.snapshot.payload,
        preview: { mimeType: "image/png", data: initialPng.toString("base64") },
      },
    });
    app = await launch(current);
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
    );
    await expect(
      page.getByRole("button", { name: /Initial state—not current interactive view/ }).first(),
    ).toBeVisible();
    const initialPreview = page
      .getByRole("region", { name: "Retained initial-state preview" })
      .first();
    await initialPreview
      .getByRole("button", { name: /Initial state—not current interactive view/ })
      .click();
    const retained = initialPreview.locator("img");
    await expect(retained).toHaveAttribute(
      "src",
      `data:image/png;base64,${initialPng.toString("base64")}`,
    );
    await scenario.prepare(page, "selected");
    const dialog = page.getByRole("dialog", { name: "Widget view evidence", exact: true });
    const frame = dialog.locator("iframe");
    const src = await frame.getAttribute("src");
    const view = dialog.locator("[data-widget-view-id]");
    await expect
      .poll(
        async () =>
          JSON.parse((await view.getAttribute("data-widget-view-identity"))!).savedState?.value,
      )
      .toEqual({ variant: "A" });
    // A covered/unavailable view must fail, not substitute retained A pixels.
    await frame.evaluate((element) => {
      element.style.visibility = "hidden";
    });
    await dialog.getByRole("button", { name: "Attach current view" }).click();
    await expect(dialog.getByRole("status")).toContainText("clipped or covered");
    await frame.evaluate((element) => {
      element.style.removeProperty("visibility");
    });
    await dialog.getByRole("button", { name: "Attach current view" }).click();
    await expect(dialog.getByRole("status")).toContainText(
      "Current view + revision added to draft",
    );
    await expect(frame.contentFrame().getByRole("heading", { name: "Variant C" })).toBeVisible();
    expect(await frame.getAttribute("src")).toBe(src);
    const output = join(repositoryRoot, ".visual-captures");
    await mkdir(output, { recursive: true });
    await dialog.screenshot({ path: join(output, "widget-view-evidence-fullscreen.png") });
    await dialog.getByRole("button", { name: "Exit fullscreen Widget view evidence" }).click();
    const attachedImage = page.getByRole("button", { name: /^View Current widget view/ });
    await expect(attachedImage).toBeVisible();
    const imageSource = await attachedImage.locator("img").getAttribute("src");
    expect(imageSource).toMatch(/^data:image\/png;base64,/);
    expect(imageSource).not.toBe(`data:image/png;base64,${initialPng.toString("base64")}`);
    const edgePixels = await app.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromDataURL(data);
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const pixel = (x: number, y: number) => [
        ...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
      ];
      return {
        top: pixel(Math.floor(width / 2), 1),
        bottom: pixel(Math.floor(width / 2), height - 2),
      };
    }, imageSource!);
    // A host error banner above the iframe must never leak in from a stale compositor frame.
    expect(edgePixels.top).toEqual(edgePixels.bottom);
    const evidenceButton = page.getByRole("button", { name: "Widget view evidence", exact: true });
    await evidenceButton.focus();
    await evidenceButton.press("Enter");
    const evidence = page.locator('[data-cake-private-preview="true"] pre');
    await expect(evidence).toContainText('"provenance": "live-widget-view"');
    await expect(evidence).toContainText('"exactRef": "cake://artifact/widget-view-evidence@r3"');
    await expect(evidence).toContainText('"variant": "A"');
    await expect(evidence).toContainText("widget-local interactive state is not reported");
    await expect(evidence).toContainText("not a complete or atomic snapshot");
    await page.keyboard.press("Escape");
    await expect(retained).toHaveAttribute(
      "src",
      `data:image/png;base64,${initialPng.toString("base64")}`,
    );
    const input = page.getByRole("combobox", { name: "Message" });
    await input.fill("Implement the attached C view");
    await expect(input).toHaveValue("Implement the attached C view");
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await writeFile(join(output, "widget-view-initial-a.png"), initialPng);
    await writeFile(
      join(output, "widget-view-live-c.png"),
      Buffer.from(imageSource!.split(",")[1]!, "base64"),
    );
    await page.screenshot({ path: join(output, "widget-view-evidence-attached.png") });
  } finally {
    await app?.close();
    await storageRuntime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
