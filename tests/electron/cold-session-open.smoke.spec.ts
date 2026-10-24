import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const scenario of [
  "preserves reading position and draft",
  "holds sending until ready",
] as const) {
  test(`cold history appears before extension startup and ${scenario}`, async () => {
    test.setTimeout(60_000);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-cold-open-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const home = join(temporaryRoot, "home");
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    let initialization: ServerResponse | undefined;
    let commands = 0;
    const server = createServer((request, response) => {
      if (request.url === "/initialize") initialization = response;
      else {
        if (request.url === "/command") commands += 1;
        response.end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const timestamp = new Date(0).toISOString();
    await Promise.all(
      [
        userData,
        sessionDirectory,
        home,
        join(cakeHome, "state"),
        join(project, ".pi", "extensions"),
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId: "source", theme: "dark" }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
        trustedProjectPaths: [project],
      }),
    );
    // A real extension lifecycle hook is the controlled boundary: no production
    // timing hooks, elapsed-time delays, provider requests, or user profile access.
    await writeFile(
      join(project, ".pi", "extensions", "cold-start.ts"),
      `
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== "target") return;
    await fetch(${JSON.stringify(`${origin}/initialize`)});
    ctx.ui.setStatus("cold-start", "ready");
  });
  pi.registerCommand("cold-ready", {
    description: "Verify initialized command delivery",
    async handler() { await fetch(${JSON.stringify(`${origin}/command`)}); }
  });
}
`,
    );
    for (const sessionId of ["source", "target"]) {
      const entries: Array<Record<string, unknown>> = [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      ];
      let parentId: string | null = null;
      const count = sessionId === "target" ? 40 : 1;
      for (let index = 0; index < count; index++) {
        const id = `message-${index}`;
        entries.push({
          type: "message",
          id,
          parentId,
          timestamp,
          message: {
            role: "user",
            timestamp: index,
            content: [
              {
                type: "text",
                text:
                  index === 0
                    ? `${sessionId} conversation`
                    : `Saved history ${index}. ${"A readable conversation recorded on disk. ".repeat(8)}`,
              },
            ],
          },
        });
        parentId = id;
      }
      await writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    }
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        HOME: home,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(
        page.locator(".transcript").getByText("source conversation", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await page.locator('.session-item[data-session-id="target"] .session-row').click();
      await expect.poll(() => Boolean(initialization)).toBe(true);
      const transcript = page.locator(".transcript");
      await expect(transcript.getByText(/^Saved history 39\./)).toBeVisible();
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      await input.focus();
      await expect(input).toBeFocused();
      await input.pressSequentially(
        scenario === "holds sending until ready" ? "/cold-ready" : "An unsent instruction",
      );
      await expect(input).toHaveValue(
        scenario === "holds sending until ready" ? "/cold-ready" : "An unsent instruction",
      );
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      if (scenario === "holds sending until ready") {
        await input.press("Escape");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        expect(commands).toBe(0);
        initialization!.end("ready");
        await expect.poll(() => commands).toBe(1);
        await expect(input).toHaveValue("");
      } else {
        // Move away from the bottom using native input, then retain a concrete
        // visible message anchor through preview-to-live replacement.
        await transcript.hover();
        await page.mouse.wheel(0, -750);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(500);
        const anchor = await transcript.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = Array.from(
            element.querySelectorAll<HTMLElement>("[data-transcript-item-key]"),
          ).find((row) => {
            const bounds = row.getBoundingClientRect();
            return bounds.top >= top && bounds.bottom <= element.getBoundingClientRect().bottom;
          });
          if (!row) throw new Error("No visible transcript anchor");
          return {
            key: row.dataset.transcriptItemKey,
            offset: row.getBoundingClientRect().top - top,
          };
        });
        initialization!.end("ready");
        await expect(page.getByText("cold-start ready", { exact: true })).toBeVisible();
        await expect(input).toHaveValue("An unsent instruction");
        await expect(input).toBeFocused();
        await expect
          .poll(() =>
            transcript.evaluate((element, anchor) => {
              const row = Array.from(
                element.querySelectorAll<HTMLElement>("[data-transcript-item-key]"),
              ).find((row) => row.dataset.transcriptItemKey === anchor.key);
              return row
                ? Math.abs(
                    row.getBoundingClientRect().top -
                      element.getBoundingClientRect().top -
                      anchor.offset,
                  )
                : Infinity;
            }, anchor),
          )
          .toBeLessThanOrEqual(2);
        expect(commands).toBe(0);
      }
      expect(errors).toEqual([]);
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      initialization?.end("ready");
      await application.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
