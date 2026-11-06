import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { findVisualCaptureScenario, seedArtifact } from "../../scripts/visual-capture/scenarios";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { WidgetBrowserOutputs } from "../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../src/services/widgets/WidgetBrowserOutputsLive";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const language of ["html", "react"] as const) {
  test(`retained ${language} artifact without a link bridge uses the host opener without popups`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-links-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("cake-chat")!;
    await scenario.seed(paths, "dark");
    const markup = `<a href="https://example.com/artifact" target="_blank"><strong>External link</strong></a>
<a href="javascript:alert('bad')" target="_blank">Unsupported scheme</a>
<a href="#local">Local section</a><section id="local">Local target</section>`;
    const source =
      language === "html"
        ? `<main>${markup}<button onclick="document.querySelector('main').insertAdjacentHTML('beforeend', '<a href=&quot;https://example.com/dynamic&quot; target=&quot;_blank&quot;>Dynamic link</a>')">Add link</button>
<button onclick="this.textContent = window.open('https://example.com/script', '_blank', 'opener') === null ? 'No popup handle' : 'Unexpected handle'">Script open</button>
<a href="data:text/plain,export" download="export.txt">Download</a></main>`
        : `import React, { useState } from "react";
export default function Links() {
  const [added, setAdded] = useState(false);
  const [opened, setOpened] = useState(false);
  return <main>${markup}
    <button onClick={() => setAdded(true)}>Add link</button>
    {added && <a href="https://example.com/dynamic" target="_blank">Dynamic link</a>}
    <button onClick={() => setOpened(window.open("https://example.com/script", "_blank", "opener") === null)}>{opened ? "No popup handle" : "Script open"}</button>
    <a href="#" download="export.txt" onClick={event => {event.currentTarget.href = URL.createObjectURL(new Blob(["export"], {type: "text/plain"}));}}>Download</a>
  </main>;
}`;
    const compiled = await compileInlineWidget(language, source, "artifact");
    const browser = await Effect.runPromise(
      Effect.flatMap(WidgetBrowserOutputs, (outputs) => outputs.retain(compiled)).pipe(
        Effect.provide(
          makeWidgetBrowserOutputsLive(
            join(paths.cakeHome, "state", "artifacts", "browser-outputs"),
          ),
        ),
      ),
    );
    const retainedPath = join(
      paths.cakeHome,
      "state",
      "artifacts",
      "browser-outputs",
      browser.digest,
      "document.html",
    );
    const retainedDocument = await readFile(retainedPath, "utf8");
    // Reproduce pre-link-bridge artifacts: publication, not recompilation, must add host capabilities.
    expect(retainedDocument).not.toContain('send("open-link"');
    await seedArtifact(
      paths,
      {
        protocol: "cake.artifact/v1",
        id: "artifact-links",
        sessionId: CAKE_CHAT_SESSION_ID,
        revision: 1,
        kind: "widget",
        title: "Artifact links",
        payload: {
          language,
          source,
          brief: "Links fixture",
          generationSessionId: "fixture",
          browser,
        },
        fallback: { markdown: "Links" },
        interaction: { mode: "present" },
      },
      new Date(0).toISOString(),
    );
    const app = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ shell, session }) => {
        const urls: string[] = [];
        const downloads: string[] = [];
        Object.assign(globalThis, { cakeTestExternalUrls: urls, cakeTestDownloads: downloads });
        session.defaultSession.on("will-download", (event, item) => {
          downloads.push(item.getFilename());
          event.preventDefault();
        });
        Object.defineProperty(shell, "openExternal", {
          configurable: true,
          value: async (url: string) => {
            urls.push(url);
          },
        });
      });
      await scenario.prepare(page, "default");
      await page.getByRole("button", { name: "1 artifacts", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Artifacts", exact: true })
        .getByRole("button", { name: /Artifact links/ })
        .click();
      const pane = page.getByRole("complementary", { name: "Artifact links", exact: true });
      const iframe = pane.locator("iframe");
      const frame = iframe.contentFrame();
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
      expect(
        await frame
          .locator("body")
          .evaluate(() => ({ origin: globalThis.origin, opener: window.opener })),
      ).toEqual({ origin: "null", opener: null });
      const opened = () =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { cakeTestExternalUrls: string[] })
              .cakeTestExternalUrls,
        );
      await frame.getByRole("link", { name: "External link" }).click();
      await expect.poll(opened).toEqual(["https://example.com/artifact"]);
      await frame.getByRole("button", { name: "Add link" }).click();
      await frame.getByRole("link", { name: "Dynamic link" }).press("Enter");
      await expect
        .poll(opened)
        .toEqual(["https://example.com/artifact", "https://example.com/dynamic"]);
      await frame.getByRole("button", { name: "Script open" }).click();
      await expect(frame.getByRole("button", { name: "No popup handle" })).toBeVisible();
      await expect
        .poll(opened)
        .toEqual([
          "https://example.com/artifact",
          "https://example.com/dynamic",
          "https://example.com/script",
        ]);
      await frame.getByRole("link", { name: "Unsupported scheme" }).click();
      await frame.getByRole("link", { name: "Local section" }).click();
      await expect.poll(() => frame.locator("body").evaluate(() => location.hash)).toBe("#local");
      await frame.getByRole("link", { name: "Download", exact: true }).click({ noWaitAfter: true });
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as typeof globalThis & { cakeTestDownloads: string[] }).cakeTestDownloads,
          ),
        )
        .toEqual(["export.txt"]);
      expect(await opened()).toEqual([
        "https://example.com/artifact",
        "https://example.com/dynamic",
        "https://example.com/script",
      ]);
      expect(await readFile(retainedPath, "utf8")).toBe(retainedDocument);
      expect(app.windows()).toHaveLength(1);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
