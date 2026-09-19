import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import type { VisualCaptureOptions } from "./arguments.ts";
import { parsePngDimensions, type VisualCaptureResult } from "./result.ts";
import { findVisualCaptureScenario } from "./scenarios.ts";

export interface CaptureVisualDependencies {
  readonly repositoryRoot?: string;
  readonly onTemporaryRoot?: (path: string) => void;
}

export async function captureVisual(
  options: VisualCaptureOptions,
  dependencies: CaptureVisualDependencies = {},
): Promise<VisualCaptureResult> {
  if (!options.scenario) throw new Error("A scenario is required");
  const scenario = findVisualCaptureScenario(options.scenario);
  if (!scenario)
    throw new Error(
      `Unknown scenario "${options.scenario}". Use --list to see available scenarios.`,
    );
  if (!scenario.states.includes(options.state))
    throw new Error(
      `Scenario "${scenario.name}" does not support state "${options.state}". ` +
        `Choose: ${scenario.states.join(", ")}.`,
    );

  const repositoryRoot = resolve(dependencies.repositoryRoot ?? join(import.meta.dirname, "../.."));
  if (options.build) await buildCompiledApplication(repositoryRoot);

  const outputPath = resolve(
    options.output ??
      join(
        options.outputDirectory,
        `${scenario.name}-${options.state}-${options.theme}-${options.capture}-${options.width}x${options.height}.png`,
      ),
  );
  if (!outputPath.toLowerCase().endsWith(".png"))
    throw new Error(`Output must be a .png file: ${outputPath}`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-visual-capture-"));
  dependencies.onTemporaryRoot?.(temporaryRoot);
  const paths = {
    cakeHome: join(temporaryRoot, "cake-home"),
    project: join(temporaryRoot, "project"),
    userData: join(temporaryRoot, "electron-user-data"),
  };
  let application: ElectronApplication | undefined;

  try {
    await scenario.seed(paths, options.theme);
    application = await electron.launch({
      args: ["--force-device-scale-factor=1", repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
      },
    });
    const page = await application.firstWindow();
    // Sandboxed documents follow media preferences, not the host's theme class.
    await page.emulateMedia({ colorScheme: options.theme });
    await application.evaluate(
      ({ BrowserWindow }, dimensions) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Cake did not create a browser window");
        window.setContentSize(dimensions.width, dimensions.height);
      },
      { width: options.width, height: options.height },
    );
    await page.waitForFunction(
      (dimensions) => innerWidth === dimensions.width && innerHeight === dimensions.height,
      { width: options.width, height: options.height },
    );
    await scenario.prepare(page, options.state, application);

    const target = options.capture === "window" ? page : scenario.region(page);
    await mkdir(dirname(outputPath), { recursive: true });
    const png = await target.screenshot({ animations: "disabled", type: "png" });
    await writeFile(outputPath, png);
    const dimensions = parsePngDimensions(png);
    return {
      schemaVersion: 1,
      scenario: scenario.name,
      state: options.state,
      dimensions,
      outputPath,
      mimeType: "image/png",
      checksum: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Capture ${scenario.name}/${options.state} failed before writing ${basename(outputPath)}: ${detail}`,
      { cause },
    );
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function buildCompiledApplication(repositoryRoot: string) {
  return new Promise<void>((resolvePromise, reject) => {
    const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(executable, ["exec", "electron-vite", "build", "--logLevel", "warn"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", (cause) =>
      reject(new Error(`Could not start the Cake build: ${cause.message}`, { cause })),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `Cake build failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
          ),
        );
    });
  });
}
