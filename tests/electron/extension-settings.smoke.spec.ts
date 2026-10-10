import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
test("automatic extension switches use the independently configured Pi home and persist native overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-extension-settings-smoke-"));
  const cakeHome = join(root, "cake-home");
  const agent = join(root, "shared-pi-agent");
  const userData = join(root, "user-data");
  await Promise.all([
    mkdir(userData),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(agent, "extensions"), { recursive: true }),
  ]);
  const document = join(agent, "settings.json");
  await writeFile(
    document,
    JSON.stringify({ quietStartup: true, extensions: ["-extensions/example.ts"] }),
  );
  const oldDocument = join(cakeHome, "pi", "settings.json");
  await writeFile(oldDocument, '{"quietStartup":false}');
  await writeFile(join(agent, "extensions", "example.ts"), "export default function () {}\n");
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: "Execution & resources", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "example.ts", exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await toggle.press("Space");
    await expect(toggle).toBeChecked();
    await expect
      .poll(async () => JSON.parse(await readFile(document, "utf8")).extensions)
      .toEqual(["+extensions/example.ts"]);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => JSON.parse(await readFile(document, "utf8")).extensions)
      .toEqual(["-extensions/example.ts"]);
    expect(JSON.parse(await readFile(document, "utf8")).quietStartup).toBe(true);
    expect(await readFile(oldDocument, "utf8")).toBe('{"quietStartup":false}');
    await page.getByRole("button", { name: "Refresh extensions", exact: true }).click();
    await expect(toggle).not.toBeChecked();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
