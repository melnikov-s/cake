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

test("production widget review captures settled sandbox pixels before persistence", async ({}, testInfo) => {
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
    await expect(page.getByRole("dialog", { name: "Reviewing rendered widget" })).toBeVisible();
    const result = await capturePromise;
    expect(result.persistedBeforeCapture).toBe(false);
    expect(result.persistedAfterCapture).toBe(true);
    expect(result.diagnostics).toContain("verticalOverflow=false");
    await expect(page.getByRole("dialog", { name: "Reviewing rendered widget" })).toHaveCount(0);

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
    expect(result.diagnostics.some((item) => /^widget=5\d\dx/.test(item))).toBe(true);
    expect(colors.size.width).toBeGreaterThan(800);
    expect(colors.size.width).toBeLessThan(1_200);

    await expect(
      capture({
        sessionId: "widget-review-session",
        workingDirectory: project,
        artifactId: "runtime-error",
        source:
          'export default function RuntimeFailure(){ throw new Error("RENDER REVIEW FAILURE"); }',
      }),
    ).rejects.toThrow("RENDER REVIEW FAILURE");

    const cancelled = capture({
      sessionId: "widget-review-session",
      workingDirectory: project,
      artifactId: "cancelled-review",
      source:
        "export default function SlowCandidate(){ return <main style={{minHeight:430}}>CANCEL ME</main>; }",
    });
    const cancelledExpectation = expect(cancelled).rejects.toThrow(/cancelled/i);
    await expect(page.getByRole("dialog", { name: "Reviewing rendered widget" })).toBeVisible();
    await page.getByRole("button", { name: "Exit fullscreen Reviewing rendered widget" }).click();
    await cancelledExpectation;
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
