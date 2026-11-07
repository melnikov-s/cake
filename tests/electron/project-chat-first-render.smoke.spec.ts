import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { seedCakeChatHistory, seedPermanentChatHistory } from "./durable-chat-fixture";

const repository = resolve(import.meta.dirname, "../..");

test("Project Chat's first transcript has its own history, including cross-project return visits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-project-first-render-"));
  const cakeHome = join(directory, "cake");
  const projects = ["Alpha", "Beta"].map((name) => {
    const path = join(directory, name);
    const hash = createHash("sha256").update(path).digest("hex");
    return { name, path, hash, sessionId: `project-chat:${hash}`, text: `${name}_ONLY_HISTORY` };
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(join(cakeHome, "state"), { recursive: true });
    for (const project of projects) {
      await mkdir(project.path);
      await seedPermanentChatHistory(
        join(cakeHome, "pi", "project-chats", project.hash),
        project.text,
      );
    }
    await seedCakeChatHistory(cakeHome, "GLOBAL_ONLY_HISTORY");
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: projects.map(({ path, name }) => ({
            path,
            name,
            addedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString(),
          })),
        },
      }),
    );
    const launchStarted = Date.now();
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByRole("button", { name: "Open Cake Chat", exact: true })).toBeVisible();
    const startupMs = Date.now() - launchStarted;
    await test.info().attach("startup-timing", {
      body: JSON.stringify({ startupMs }),
      contentType: "application/json",
    });
    expect(startupMs).toBeLessThan(4_000);
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await expect(page.getByText("GLOBAL_ONLY_HISTORY", { exact: true })).toBeVisible();
    for (const project of [projects[0]!, projects[1]!, projects[0]!]) {
      // Observe actual DOM commits, not just Playwright's eventual visible state.
      await page.evaluate((id) => {
        const samples: { text: string; elapsedMs: number }[] = [];
        let started = performance.now();
        document.addEventListener(
          "click",
          () => {
            started = performance.now();
          },
          { once: true, capture: true },
        );
        const observer = new MutationObserver(() => {
          const pane = document.querySelector(
            `[data-slot="session-pane"][data-session-id="${id}"]`,
          );
          const transcript = pane?.querySelector('[data-slot="content-transition-live"]');
          if (transcript)
            samples.push({
              text: transcript.textContent ?? "",
              elapsedMs: performance.now() - started,
            });
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        Object.assign(window, { firstRenderTrace: { samples, observer } });
      }, project.sessionId);
      await page
        .getByRole("button", { name: `Open Project Chat for ${project.name}`, exact: true })
        .click();
      const pane = page.locator(
        `[data-slot="session-pane"][data-session-id="${project.sessionId}"]`,
      );
      await expect(pane.getByText(project.text, { exact: true })).toBeVisible();
      const trace = await page.evaluate(() => {
        const trace = Reflect.get(window, "firstRenderTrace") as {
          samples: { text: string; elapsedMs: number }[];
          observer: MutationObserver;
        };
        trace.observer.disconnect();
        return trace.samples;
      });
      await test.info().attach(`${project.name}-navigation`, {
        body: JSON.stringify(trace),
        contentType: "application/json",
      });
      expect(trace.length).toBeGreaterThan(0);
      expect(trace[0]!.elapsedMs).toBeLessThan(100);
      // Virtuoso mounts its measuring tree before its rows; the first actual
      // transcript content must be history, never a guessed empty state.
      expect(trace.find(({ text }) => text.length > 0)?.text).toContain(project.text);
      expect(trace.every(({ text }) => !text.includes("Let’s talk about this project"))).toBe(true);
      expect(trace.every(({ text }) => !text.includes("GLOBAL_ONLY_HISTORY"))).toBe(true);
      expect(
        trace.every(
          ({ text }) => !text.includes(projects.find((other) => other !== project)!.text),
        ),
      ).toBe(true);
    }
    const input = page.getByRole("combobox", { name: "Message Project Chat" });
    await expect(input).toBeFocused();
    await input.pressSequentially("Keep this draft");
    await expect(input).toHaveValue("Keep this draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
