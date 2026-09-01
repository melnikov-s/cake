import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("executes a compiled React widget in its sandboxed document origin", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-inline-widget-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({ schemaVersion: 1, projects: [], trustedProjectPaths: [] }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

  try {
    const page = await application.firstWindow();
    const harness = await openRpcHarness(application, "inline-widget");
    const response = await callRpcHarness<{
      type: string;
      widget: { url: string };
    }>(harness, "invokePrivileged", {
      type: "compile-inline-widget",
      language: "react",
      capability: "display",
      source: "export default function Widget() { return <strong>React widget executed</strong>; }",
    });
    if (response.type !== "inline-widget-compiled")
      throw new Error("Inline widget did not compile");
    const widgetUrl = response.widget.url;
    await page.evaluate((url) => {
      const frame = document.createElement("iframe");
      frame.title = "CSP React widget";
      frame.sandbox.add("allow-scripts");
      frame.src = url;
      document.body.append(frame);
    }, widgetUrl);

    await expect(
      page.frameLocator('iframe[title="CSP React widget"]').getByText("React widget executed"),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
