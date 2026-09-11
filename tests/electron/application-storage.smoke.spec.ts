import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const launch = (temporaryRoot: string) =>
  electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

test("legacy Application storage migrates before normal renderer hydration", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-application-storage-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  const application = await launch(temporaryRoot);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "What should we build?" })).toBeVisible({
      timeout: 20_000,
    });
    const document = JSON.parse(
      await readFile(join(cakeHome, "state", "application.json"), "utf8"),
    );
    expect(document.version).toBe(2);
    expect(document.data).toMatchObject({
      projects: [],
      modelPresets: [],
      globalWorkflowStatuses: expect.any(Array),
    });
    expect(document.data).not.toHaveProperty("schemaVersion");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("malformed Application storage fails startup without overwriting the source", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-application-corrupt-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
  await mkdir(join(cakeHome, "state"), { recursive: true });
  const target = join(cakeHome, "state", "application.json");
  await writeFile(target, "{ malformed", "utf8");
  const application = await launch(temporaryRoot);
  const child = application.process();
  try {
    const exitCode =
      child.exitCode ??
      (await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)));
    expect(exitCode).toBe(1);
    expect(await readFile(target, "utf8")).toBe("{ malformed");
  } finally {
    if (child.exitCode === null) await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
