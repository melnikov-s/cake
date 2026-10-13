import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("executes compiled React in the sandboxed document origin", async () => {
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
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

    const iframe = page.locator('iframe[title="CSP React widget"]');
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    // Real Chromium fetch from the opaque sandbox catches lost custom-scheme privileges.
    const localFetch = await iframe
      .contentFrame()
      .locator("body")
      .evaluate(async () => {
        const response = await fetch(location.href.split("#")[0]!);
        return { status: response.status, source: await response.text() };
      });
    expect(localFetch.status).toBe(200);
    expect(localFetch.source).toContain("React widget executed");

    const expanding = await callRpcHarness<{
      widget: { token: string; url: string };
    }>(harness, "invokeNative", {
      type: "compile-inline-widget",
      language: "react",
      capability: "display",
      source: `import React, { useState } from "react";
export default function ExpandingWidget() {
  const [expanded, setExpanded] = useState(false);
  return <main><button onClick={() => setExpanded(true)}>Expand after ready</button>
    {expanded && <section style={{ minHeight: 720 }}><p>Late content</p><button>Reachable late control</button></section>}
  </main>;
}`,
    });
    await page.evaluate(({ url, token }) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="CSP React widget"]');
      if (!frame) throw new Error("Widget frame is unavailable");
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        // SAFETY: Each field is checked below before use; this listener only adapts the fixed fixture bridge.
        const data = event.data as {
          source?: string;
          token?: string;
          type?: string;
          value?: number;
        };
        if (data.source !== "cake-inline-widget" || data.token !== token) return;
        if (data.type === "height" && typeof data.value === "number")
          frame.style.height = `${Math.ceil(data.value)}px`;
      };
      window.addEventListener("message", receive);
      frame.src = url;
    }, expanding.widget);
    const expandingFrame = iframe.contentFrame();
    await expect(expandingFrame.getByRole("button", { name: "Expand after ready" })).toBeVisible();
    await expect(expandingFrame.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
    const initialHeight = await iframe.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await expandingFrame.getByRole("button", { name: "Expand after ready" }).click();
    await expect
      .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(initialHeight + 500);
    await expect(
      expandingFrame.getByRole("button", { name: "Reachable late control" }),
    ).toBeVisible();

    const artifact = await callRpcHarness<{ widget: { token: string; url: string } }>(
      harness,
      "invokeNative",
      {
        type: "compile-inline-widget",
        language: "react",
        capability: "artifact",
        source: `import { useRef, useState } from "react";
import { useArtifact, useArtifactState } from "@cake/artifact-sdk";
export default function Editor() {
  const state = useArtifactState({count: 0});
  const artifact = useArtifact();
  const queued = useRef(null);
  const [notice, setNotice] = useState("");
  if (state.hydrated && !queued.current) queued.current = {save: state.save, replace: artifact.replace};
  const replay = (method) => queued.current[method]({count: 999}).then(
    () => setNotice("OVERWROTE NEWER DATA"),
    () => {
      const snapshot = globalThis.__cakeArtifactBridge.getSnapshot();
      setNotice(method + " rejected after refresh " + snapshot.version + ":" + snapshot.error);
    },
  );
  if (!state.hydrated) return <p>Hydrating artifact</p>;
  return <main><button onClick={() => state.save({count: state.value.count + 1})}>Saved count {state.value.count}</button>
    <button onClick={() => replay("save")}>Replay stale save</button>
    <button onClick={() => replay("replace")}>Replay stale replace</button><output>{notice}</output></main>;
}`,
      },
    );
    await page.evaluate(({ url, token }) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="CSP React widget"]');
      if (!frame) throw new Error("Widget frame is unavailable");
      let state = { version: 1, value: { count: 2 } };
      const staleVersions: number[] = [];
      Object.assign(window, {
        __cakeArtifactStaleVersions: staleVersions,
        __cakeArtifactRemote() {
          state = { version: 3, value: { count: 8 } };
          frame.contentWindow?.postMessage(
            { source: "cake-artifact-host", token, type: "state", value: state },
            "*",
          );
        },
      });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        // SAFETY: Fixed fixture's protocol fields are checked before processing any state request.
        const message = event.data as {
          source?: string;
          token?: string;
          type?: string;
          value?: { id?: string; expectedVersion?: number; value?: { count: number } };
        };
        if (
          message.source !== "cake-inline-widget" ||
          message.token !== token ||
          !message.value?.id
        )
          return;
        if (message.type === "artifact-state-replace") {
          if (message.value.expectedVersion !== state.version || !message.value.value) {
            staleVersions.push(message.value.expectedVersion!);
            frame.contentWindow?.postMessage(
              {
                source: "cake-artifact-host",
                token,
                type: "state-result",
                value: { id: message.value.id, ok: false, error: "Stale state version" },
              },
              "*",
            );
            return;
          }
          state = { version: state.version + 1, value: message.value.value };
          Object.assign(window, { __cakeArtifactSmokeSaved: state });
        }
        if (message.type === "artifact-state-read" || message.type === "artifact-state-replace")
          frame.contentWindow?.postMessage(
            {
              source: "cake-artifact-host",
              token,
              type: "state-result",
              value: { id: message.value.id, ok: true, state },
            },
            "*",
          );
      });
      frame.src = url;
    }, artifact.widget);
    const artifactFrame = iframe.contentFrame();
    await expect(artifactFrame.getByRole("button", { name: "Saved count 2" })).toBeVisible();
    await artifactFrame.getByRole("button", { name: "Saved count 2" }).click();
    await expect(artifactFrame.getByRole("button", { name: "Saved count 3" })).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "__cakeArtifactSmokeSaved"))).toEqual({
      version: 2,
      value: { count: 3 },
    });
    // The mounted widget responds to an agent/host invalidation without reloading its frame.
    await page.evaluate(() => Reflect.get(window, "__cakeArtifactRemote")());
    await expect(artifactFrame.getByRole("button", { name: "Saved count 8" })).toBeVisible();
    await page.evaluate(() => {
      document
        .querySelector<HTMLIFrameElement>('iframe[title="CSP React widget"]')
        ?.contentWindow?.postMessage(
          {
            source: "cake-artifact-host",
            token: "wrong-token",
            type: "state",
            value: { version: 4, value: { count: 999 } },
          },
          "*",
        );
    });
    await expect(artifactFrame.getByRole("button", { name: "Saved count 8" })).toBeVisible();

    // Old rendered callbacks must use their original CAS version, not the bridge\'s latest version.
    await artifactFrame.getByRole("button", { name: "Replay stale save" }).click();
    await expect(artifactFrame.getByText("save rejected after refresh 3:null")).toBeVisible();
    await artifactFrame.getByRole("button", { name: "Replay stale replace" }).click();
    await expect(artifactFrame.getByText("replace rejected after refresh 3:null")).toBeVisible();
    await expect(artifactFrame.getByRole("button", { name: "Saved count 8" })).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "__cakeArtifactStaleVersions"))).toEqual([
      1, 1,
    ]);

    const plugin = await callRpcHarness<{
      widget: { token: string; url: string };
    }>(harness, "invokeNative", {
      type: "compile-inline-widget",
      language: "react",
      capability: "session-plugin",
      source: `import { useCake, usePluginState } from "@cake/plugin-sdk";
export default function TourPlugin() {
  const cake = useCake();
  const [state] = usePluginState({ current: 0 });
  return <button onClick={() => cake.session.sendMessage("Next")}>Next from {state.current}</button>;
}`,
    });
    await page.evaluate(({ url, token }) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="CSP React widget"]');
      if (!frame) throw new Error("Widget frame is unavailable");
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        // SAFETY: This fixed smoke fixture checks the source and capability token before use.
        const data = event.data as {
          source?: string;
          token?: string;
          type?: string;
          value?: { id?: string; command?: string; input?: unknown };
        };
        if (data.source !== "cake-inline-widget" || data.token !== token) return;
        if (data.type === "ready")
          frame.contentWindow?.postMessage(
            {
              source: "cake-session-plugin-host",
              token,
              type: "context",
              value: { pluginState: { current: 2 }, sharedState: {} },
            },
            "*",
          );
        if (data.type === "plugin-call" && data.value?.id) {
          Object.assign(window, { __cakePluginSmokeCall: data.value });
          frame.contentWindow?.postMessage(
            {
              source: "cake-session-plugin-host",
              token,
              type: "call-result",
              value: { id: data.value.id, ok: true, result: { accepted: true } },
            },
            "*",
          );
        }
      };
      window.addEventListener("message", receive);
      frame.src = url;
    }, plugin.widget);
    const pluginFrame = iframe.contentFrame();
    await expect(pluginFrame.getByRole("button", { name: "Next from 2" })).toBeVisible();
    await pluginFrame.getByRole("button", { name: "Next from 2" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Reflect.get(window, "__cakePluginSmokeCall") as
              | { command?: string; input?: { text?: string } }
              | undefined,
        ),
      )
      .toMatchObject({ command: "session.prompt", input: { text: "Next" } });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
