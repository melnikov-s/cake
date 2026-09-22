import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

type CaptureResult = {
  pngBase64: string;
  diagnostics: string[];
  persistedBeforeCapture: boolean;
  persistedAfterCapture: boolean;
};

test("production widget review captures settled sandbox pixels before persistence", async () => {
  const testInfo = test.info();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-widget-review-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "light",
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
    }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.addStyleTag({
      content: '[role="dialog"][aria-modal="true"]{background:rgb(255,0,255)!important}',
    });
    const capture = (input: {
      sessionId: string;
      workingDirectory: string;
      artifactId: string;
      source: string;
      pluginState?: { topic: string };
      cancelAfterMs?: number;
    }) =>
      application.evaluate((_electron, value) => {
        const operation = (
          globalThis as typeof globalThis & {
            cakeSmokeCaptureInlineWidget?: (request: typeof value) => Promise<CaptureResult>;
          }
        ).cakeSmokeCaptureInlineWidget;
        if (!operation) throw new Error("Widget capture smoke hook is unavailable");
        return operation(value);
      }, input);
    const captureWindowCount = () =>
      application.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (window) => window.getTitle() === "Cake Widget Review Capture",
          ).length,
      );
    const source = `import React, { useEffect, useState } from "react";
export default function DelayedReviewFixture() {
  const [settled, setSettled] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSettled(true), 300); return () => clearTimeout(timer); }, []);
  return <main style={{ minHeight: 430, background: settled ? "rgb(0, 220, 220)" : "rgb(255, 165, 0)", padding: 30 }}>
    <h1>{settled ? "ASYNC LAYOUT SETTLED" : "WAITING FOR LAYOUT"}</h1>
    {settled && <div aria-label="settled marker" style={{ width: 120, height: 120, background: "rgb(240, 20, 20)" }} />}
  </main>;
}`;
    const capturePromise = capture({
      sessionId: "widget-review-session",
      workingDirectory: project,
      artifactId: "delayed-review",
      source,
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => {
          const captureWindow = BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === "Cake Widget Review Capture",
          );
          return captureWindow
            ? {
                visible: captureWindow.isVisible(),
                focusable: captureWindow.isFocusable(),
                offscreen: captureWindow.webContents.getURL().startsWith("data:"),
              }
            : undefined;
        }),
      )
      .toEqual({ visible: false, focusable: false, offscreen: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Widget specialist")).toHaveCount(0);
    const result = await capturePromise;
    await expect.poll(captureWindowCount).toBe(0);
    expect(result.persistedBeforeCapture).toBe(false);
    expect(result.persistedAfterCapture).toBe(true);
    expect(result.diagnostics).toContain("verticalOverflow=false");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const capturedPng = Buffer.from(result.pngBase64, "base64");
    await mkdir(join(repositoryRoot, ".visual-captures"), { recursive: true });
    await writeFile(
      join(repositoryRoot, ".visual-captures", "widget-rendered-review.png"),
      capturedPng,
    );
    await testInfo.attach("captured-widget-review.png", {
      body: capturedPng,
      contentType: "image/png",
    });
    const colors = await application.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      const bitmap = image.toBitmap();
      let cyan = 0;
      let red = 0;
      let magenta = 0;
      for (let index = 0; index < bitmap.length; index += 4) {
        const blue = bitmap[index] ?? 0;
        const green = bitmap[index + 1] ?? 0;
        const redChannel = bitmap[index + 2] ?? 0;
        if (redChannel < 30 && green > 180 && blue > 180) cyan += 1;
        if (redChannel > 180 && green < 60 && blue < 60) red += 1;
        if (redChannel > 180 && green < 60 && blue > 180) magenta += 1;
      }
      return { cyan, red, magenta, size: image.getSize() };
    }, result.pngBase64);
    expect(colors.cyan).toBeGreaterThan(20_000);
    expect(colors.red).toBeGreaterThan(5_000);
    expect(colors.magenta).toBe(0);
    expect(result.diagnostics).toContain("widget=560x480");
    expect(result.diagnostics).toContain("host=hidden-offscreen");
    expect(colors.size.width).toBeGreaterThan(800);
    expect(colors.size.width).toBeLessThan(1_200);

    // A generated plugin must be reviewed with host state, not just its hook default.
    const plugin = await capture({
      sessionId: "widget-review-session",
      workingDirectory: project,
      artifactId: "plugin-state-review",
      pluginState: { topic: "Authority" },
      source: `import { usePluginState } from "@cake/plugin-sdk";
export default function StateReviewFixture() {
  const [state] = usePluginState({ topic: "Default" });
  return <main style={{ height: 430, background: state.topic === "Authority" ? "rgb(0, 220, 220)" : "rgb(255, 0, 255)" }}>{state.topic}</main>;
}`,
    });
    const pluginPixel = await application.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      return [...bitmap.subarray(center, center + 3)];
    }, plugin.pngBase64);
    expect(pluginPixel).toEqual([220, 220, 0]);

    await expect(
      capture({
        sessionId: "widget-review-session",
        workingDirectory: project,
        artifactId: "runtime-error",
        source:
          'export default function RuntimeFailure(){ throw new Error("RENDER REVIEW FAILURE"); }',
      }),
    ).rejects.toThrow("RENDER REVIEW FAILURE");
    await expect.poll(captureWindowCount).toBe(0);

    await expect(
      capture({
        sessionId: "widget-review-session",
        workingDirectory: project,
        artifactId: "cancelled-review",
        source:
          "export default function SlowCandidate(){ return <main style={{minHeight:430}}>CANCEL ME</main>; }",
        cancelAfterMs: 100,
      }),
    ).rejects.toThrow(/cancelled/i);
    await expect.poll(captureWindowCount).toBe(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
