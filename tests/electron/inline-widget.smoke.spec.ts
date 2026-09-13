import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("executes compiled React and real ELK layout in the sandboxed document origin", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-inline-widget-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({ schemaVersion: 1, projects: [], trustedProjectPaths: [] }),
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
    const harness = await openRpcHarness(application, "inline-widget");
    const response = await callRpcHarness<{
      widget: { url: string };
    }>(harness, "invokeNative", {
      type: "compile-inline-widget",
      language: "react",
      capability: "display",
      source: "export default function Widget() { return <strong>React widget executed</strong>; }",
    });
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

    const elk = await callRpcHarness<{ widget: { url: string } }>(harness, "invokeNative", {
      type: "compile-inline-widget",
      language: "react",
      capability: "display",
      source: `import React, { useEffect, useState } from "react";
import ELK from "elkjs/lib/elk.bundled.js";
export default function LayoutProof() {
  const [result, setResult] = useState(null);
  useEffect(() => {
    const elk = new ELK();
    elk.layout({ id: "root", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
      children: [{ id: "a", width: 80, height: 40 }, { id: "b", width: 80, height: 40 }],
      edges: [{ id: "ab", sources: ["a"], targets: ["b"] }]
    }).then(setResult).catch(error => setResult({ error: String(error) }));
  }, []);
  return <pre aria-label="ELK layout result">{JSON.stringify(result)}</pre>;
}`,
    });
    const iframe = page.locator('iframe[title="CSP React widget"]');
    await iframe.evaluate((element, url) => element.setAttribute("src", url), elk.widget.url);
    const result = iframe.contentFrame().getByLabel("ELK layout result");
    await expect(result).toContainText('"sections"');
    // SAFETY: This is JSON from the fixed ELK fixture above, not user source. The
    // assertions below verify its returned node geometry and routed edge sections.
    const layout = JSON.parse((await result.textContent())!) as {
      width: number;
      height: number;
      children: { x: number; y: number; width: number; height: number }[];
      edges: { sections: { startPoint: { x: number }; endPoint: { x: number } }[] }[];
    };
    expect(layout.children).toHaveLength(2);
    const [a, b] = layout.children;
    expect(b!.x).toBeGreaterThan(a!.x + a!.width);
    expect(layout.width).toBeGreaterThan(b!.x + b!.width);
    expect(layout.height).toBeGreaterThan(a!.height);
    const section = layout.edges[0]!.sections[0]!;
    expect(section.startPoint.x).toBe(a!.x + a!.width);
    expect(section.endPoint.x).toBe(b!.x);
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
