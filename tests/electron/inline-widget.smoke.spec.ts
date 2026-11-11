import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function verifyInlineWidget(language: "react" | "html") {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-inline-widget-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({ schemaVersion: 1, projects: [] }),
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

    if (language === "react") {
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
        // This fixture adapts a content-sized display; ordinary artifacts use fixed viewports.
        frame.src = `${url}#cake-widget=${encodeURIComponent(JSON.stringify({ sizing: "content" }))}`;
      }, expanding.widget);
      const expandingFrame = iframe.contentFrame();
      await expect(
        expandingFrame.getByRole("button", { name: "Expand after ready" }),
      ).toBeVisible();
      await expect(expandingFrame.locator("html")).toHaveAttribute(
        "data-cake-widget-ready",
        "true",
      );
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
    }

    const artifact = await callRpcHarness<{ widget: { token: string; url: string } }>(
      harness,
      "invokeNative",
      {
        type: "compile-inline-widget",
        language,
        capability: "artifact",
        source:
          language === "html"
            ? `<!doctype html><html><head><style>
body{background:transparent}main{background:Canvas;color:CanvasText;display:flex;flex-wrap:wrap;gap:12px;padding:20px}
h1,output{flex-basis:100%}button{padding:10px;border:1px solid var(--border);border-radius:6px;color:var(--foreground);background:var(--background)}
</style></head><body><main><h1>Saved HTML counter</h1>
<button id="save" disabled>Hydrating artifact</button><button id="stale-save">Replay stale save</button>
<button id="stale-replace">Replay stale replace</button><output></output></main><script>
const api = globalThis.cakeArtifact;
let queuedVersion;
function render() {
  const state = api.getSnapshot();
  const button = document.querySelector("#save");
  button.disabled = !state.hydrated || !!state.error;
  if (!state.hydrated) return;
  if (queuedVersion === undefined) queuedVersion = state.version;
  const value = state.version === 0 ? {count: 0} : state.value;
  button.textContent = "Saved count " + value.count;
}
api.subscribe(render);
const navigation = document.createElement("p");
navigation.id = "navigation";
document.querySelector("main").append(navigation);
const renderContext = () => { navigation.textContent = "Project " + (api.getContext()?.project?.path ?? "none"); };
api.subscribeContext(renderContext);
renderContext();
render();
document.querySelector("#save").onclick = async () => {
  const state = api.getSnapshot();
  await api.replace({count: state.value.count + 1}, state.version);
};
for (const method of ["save", "replace"]) {
  document.querySelector("#stale-" + method).onclick = async () => {
    try { await api.replace({count: 999}, queuedVersion); }
    catch {
      const state = api.getSnapshot();
      document.querySelector("output").textContent = method + " rejected after refresh " + state.version + ":" + state.error;
    }
  };
}
</script></body></html>`
            : `import { useRef, useState } from "react";
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
    <button onClick={() => replay("replace")}>Replay stale replace</button><output>{notice}</output>
    <p id="navigation">Project {artifact.context?.project?.path ?? "none"}</p></main>;
}`,
      },
    );
    await page.evaluate(({ url, token }) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="CSP React widget"]');
      if (!frame) throw new Error("Widget frame is unavailable");
      frame.style.width = "560px";
      frame.style.height = "400px";
      let state = { version: 1, value: { count: 2 } };
      let projectPath = "/a";
      const postContext = () =>
        frame.contentWindow?.postMessage(
          {
            source: "cake-artifact-host",
            token,
            type: "context",
            value: {
              windowId: "smoke-window",
              viewId: "smoke-view",
              project: { path: projectPath, name: projectPath },
              session: null,
            },
          },
          "*",
        );
      const staleVersions: number[] = [];
      let interactions = 0;
      Object.assign(window, {
        __cakeArtifactStaleVersions: staleVersions,
        __cakeArtifactNavigation(path: string) {
          projectPath = path;
          postContext();
        },
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
          value?: {
            id?: string;
            expectedVersion?: number;
            value?: { count: number };
            name?: string;
            command?: string;
            input?: unknown;
          };
        };
        if (message.source !== "cake-inline-widget" || message.token !== token) return;
        if (message.type === "artifact-interaction") {
          Object.assign(window, { __cakeArtifactInteractions: ++interactions });
          return;
        }
        if (message.type === "artifact-state-read") postContext();
        if (!message.value?.id) return;
        if (message.type === "artifact-tool-call" || message.type === "artifact-cake-call") {
          Object.assign(window, { __cakeArtifactCall: { type: message.type, ...message.value } });
          frame.contentWindow?.postMessage(
            {
              source: "cake-artifact-host",
              token,
              type: "call-result",
              value: { id: message.value.id, ok: true, result: { accepted: true } },
            },
            "*",
          );
          return;
        }
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
    const save = artifactFrame.getByRole("button", { name: "Saved count 2" });
    await expect(save).toBeVisible();
    await expect(artifactFrame.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
    if (language === "react") {
      // This path navigates the same hidden React frame through several documents.
      // Target its real control with native keys rather than stale pointer hit regions.
      await save.focus();
      await expect(save).toBeFocused();
      await save.press("Enter");
    } else await save.click();
    await expect(artifactFrame.getByRole("button", { name: "Saved count 3" })).toBeVisible();
    await expect(artifactFrame.getByText("Project /a", { exact: true })).toBeVisible();
    await page.evaluate(() => Reflect.get(window, "__cakeArtifactNavigation")("/b"));
    await expect(artifactFrame.getByText("Project /b", { exact: true })).toBeVisible();
    // Navigation updates the mounted SDK subscription, not the document or local controls.
    await expect(artifactFrame.getByRole("button", { name: "Saved count 3" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__cakeArtifactInteractions")))
      .toBeGreaterThan(0);
    const toolResult = await artifactFrame
      .locator("body")
      .evaluate(async () =>
        Reflect.get(globalThis, "cakeArtifact").callTool("increment", { amount: 1 }),
      );
    expect(toolResult).toEqual({ accepted: true });
    expect(await page.evaluate(() => Reflect.get(window, "__cakeArtifactCall"))).toMatchObject({
      type: "artifact-tool-call",
      name: "increment",
      input: { amount: 1 },
    });
    const cakeResult = await artifactFrame
      .locator("body")
      .evaluate(async () => Reflect.get(globalThis, "cake").call("sessions.list", {}));
    expect(cakeResult).toEqual({ accepted: true });
    expect(await page.evaluate(() => Reflect.get(window, "__cakeArtifactCall"))).toMatchObject({
      type: "artifact-cake-call",
      command: "sessions.list",
      input: {},
    });
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

    // Reopen the same HTML/React source: mutable state belongs to the host, not the frame.
    await iframe.evaluate((element) => {
      const frame = element as HTMLIFrameElement;
      const url = frame.src;
      frame.src = url;
    });
    await expect(artifactFrame.getByRole("button", { name: "Saved count 8" })).toBeVisible();
    expect(
      await artifactFrame.locator("body").evaluate(() => {
        let parentDom = false;
        try {
          parentDom = !!parent.document.body;
        } catch {
          /* Opaque sandbox: parent DOM must remain inaccessible. */
        }
        return {
          parentDom,
          node: typeof Reflect.get(globalThis, "require"),
          electron: typeof Reflect.get(globalThis, "electron"),
        };
      }),
    ).toEqual({ parentDom: false, node: "undefined", electron: "undefined" });
    if (language === "html") {
      await mkdir(join(repositoryRoot, ".visual-captures"), { recursive: true });
      const screenshot = await iframe.screenshot({
        path: join(repositoryRoot, ".visual-captures", "html-widget-state.png"),
      });
      await test
        .info()
        .attach("html-widget-state.png", { body: screenshot, contentType: "image/png" });
    }

    const interactive = await callRpcHarness<{ widget: { token: string; url: string } }>(
      harness,
      "invokeNative",
      {
        type: "compile-inline-widget",
        language: "react",
        capability: "artifact",
        source: `import { useCake, useArtifactState } from "@cake/artifact-sdk";
export default function TourWidget() {
  const cake = useCake();
  const { value: state } = useArtifactState({ current: 0 });
  return <button onClick={() => cake.tools.call("chat.prompt", {sessionId: "fixture", text: "Next"})}>Next from {state.current}</button>;
}`,
      },
    );
    await page.evaluate(({ url, token }) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="CSP React widget"]');
      if (!frame) throw new Error("Widget frame is unavailable");
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        // SAFETY: This controlled fixture checks frame provenance and capability token.
        const data = event.data as {
          source?: string;
          token?: string;
          type?: string;
          value?: { id?: string; command?: string; input?: unknown };
        };
        if (data.source !== "cake-inline-widget" || data.token !== token) return;
        if (data.type === "artifact-state-read")
          frame.contentWindow?.postMessage(
            {
              source: "cake-artifact-host",
              token,
              type: "state-result",
              value: {
                id: data.value?.id,
                ok: true,
                state: { lineageId: "fixture", version: 1, value: { current: 2 } },
              },
            },
            "*",
          );
        if (data.type === "artifact-cake-call" && data.value?.id) {
          Object.assign(window, { __cakeWidgetSmokeCall: data.value });
          frame.contentWindow?.postMessage(
            {
              source: "cake-artifact-host",
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
    }, interactive.widget);
    const interactiveFrame = iframe.contentFrame();
    await expect(interactiveFrame.getByRole("button", { name: "Next from 2" })).toBeVisible();
    await interactiveFrame.getByRole("button", { name: "Next from 2" }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__cakeWidgetSmokeCall")))
      .toMatchObject({ command: "chat.prompt", input: { sessionId: "fixture", text: "Next" } });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("executes compiled React in the sandboxed document origin", () => verifyInlineWidget("react"));
test("executes HTML interaction and saved state in the sandboxed document origin", () =>
  verifyInlineWidget("html"));
