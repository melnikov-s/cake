import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type * as Esbuild from "esbuild";
import type * as NodePty from "node-pty";
import { windowState } from "../fixtures/window-state";

const source = process.env.CAKE_PACKAGED_APP;

test("standalone app launches after relocation and manual replacement preserves settings and chats", async () => {
  test.skip(!source, "Set CAKE_PACKAGED_APP to a full distribution build of Cake.app.");
  test.setTimeout(120_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-installed-smoke-"));
  const installed = join(temporaryRoot, "Applications", "Cake.app");
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const agent = join(temporaryRoot, "pi-agent");
  const project = join(temporaryRoot, "project");
  const sessions = join(
    agent,
    "sessions",
    `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  const transcript = join(sessions, "existing.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const originalChat =
    [
      { type: "session", version: 3, id: "existing-chat", timestamp, cwd: project },
      {
        type: "message",
        id: "user-entry",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Keep this packaged chat." }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessions, { recursive: true }),
  ]);
  await writeFile(transcript, originalChat);
  await writeFile(join(agent, "settings.json"), '{"defaultThinkingLevel":"medium"}\n');
  await writeFile(join(userData, "window-state.json"), windowState({ project }));
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "Installed fixture",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
    }),
  );
  const replaceApp = async () => {
    await rm(installed, { recursive: true, force: true });
    await cp(resolve(source!), installed, { recursive: true, verbatimSymlinks: true });
  };
  const launch = () =>
    electron.launch({
      executablePath: join(installed, "Contents", "MacOS", "Cake"),
      args: [],
      cwd: temporaryRoot,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        NODE_PATH: "",
        ELECTRON_RENDERER_URL: "",
        ELECTRON_RUN_AS_NODE: "",
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await replaceApp();
    const canonical = await realpath(installed);
    for (const entry of await readdir(installed, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        expect(
          (await realpath(join(entry.parentPath, entry.name))).startsWith(canonical + sep),
        ).toBe(true);
      }
    }
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
    const resources = join(installed, "Contents", "Resources", "app");
    const modules = join(resources, "node_modules");
    for (const resource of [
      "README.md",
      "CHANGELOG.md",
      "docs/extensions.md",
      "examples/extensions/README.md",
    ])
      expect(
        (await readFile(join(modules, "@earendil-works/pi-coding-agent", resource))).length,
      ).toBeGreaterThan(0);
    // Signing must not change model/WASM/resource bytes.
    for (const relative of [
      "out/main/native/FluidAudio_FluidAudio.bundle/luxtts_en_us_lexicon.tsv.zz",
      "out/main/native/silero-vad-unified-256ms-v6.2.1.mlmodelc/weights/weight.bin",
      "node_modules/shiki/dist/onig.wasm",
    ]) {
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      expect(hash(await readFile(join(resources, relative)))).toBe(
        hash(await readFile(resolve(import.meta.dirname, "../..", relative))),
      );
    }
    const dictation = execFileSync(
      join(resources, "out/main/native/cake-dictation"),
      ["--version"],
      { cwd: temporaryRoot, encoding: "utf8" },
    );
    expect(JSON.parse(dictation)).toMatchObject({ protocolVersion: 3, minimumMacOS: "14.0" });
    // Missing optional speech models must yield a protocol error, not a loader/permission failure.
    const speech = spawnSync(join(resources, "out/main/native/cake-speech"), [], {
      cwd: temporaryRoot,
      encoding: "utf8",
    });
    expect(speech.error).toBeUndefined();
    expect(JSON.parse(speech.stdout)).toHaveProperty("error");

    application = await launch();
    const page = await application.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(
      await application.evaluate(({ app, BrowserWindow, Menu }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
        hidden: BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        updates: Menu.getApplicationMenu()?.items[0]?.submenu?.items.some(
          (item) => item.label === "Check for Updates…" && item.enabled,
        ),
      })),
    ).toMatchObject({
      packaged: true,
      path: await realpath(resources),
      hidden: true,
      updates: true,
    });
    const runtime = await application.evaluate(async ({ app }) => {
      const { createRequire } = process.getBuiltinModule("module");
      const load = createRequire(`${app.getAppPath()}/package.json`);
      const esbuild = load("esbuild") as typeof Esbuild;
      const transformed = await esbuild.transform("const answer: number = 42", { loader: "ts" });
      const pty = load("node-pty") as typeof NodePty;
      const terminal = pty.spawn("/bin/sh", ["-c", "printf packaged-pty"], {
        name: "xterm",
        cols: 80,
        rows: 24,
        cwd: app.getPath("temp"),
      });
      let output = "";
      terminal.onData((data) => {
        output += data;
      });
      await new Promise<void>((done) => terminal.onExit(() => done()));
      return { compiled: transformed.code, terminal: output };
    });
    expect(runtime.compiled).toContain("42");
    expect(runtime.terminal).toBe("packaged-pty");
    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: /^Appearance/ }).click();
    await page.getByLabel("Color theme", { exact: true }).selectOption("dark");
    await application.close();
    application = undefined;
    await replaceApp();
    application = await launch();
    const restored = await application.firstWindow();
    await restored.getByRole("button", { name: /^Appearance/ }).click({ timeout: 30_000 });
    await expect(restored.getByLabel("Color theme", { exact: true })).toHaveValue("dark");
    expect(await readFile(transcript, "utf8")).toBe(originalChat);
    expect(JSON.parse(await readFile(join(agent, "settings.json"), "utf8"))).toMatchObject({
      defaultThinkingLevel: "medium",
    });
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
