import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("architecture citations with heading anchors open their workspace document", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-document-links-"));
  const project = join(temporaryRoot, "project");
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "document-links-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(join(project, "docs", "architecture"), { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(project, "docs", "architecture", "s4-artifact-protocol.md"),
    "# Artifact protocol\n\n## Authority and durability\n\nDocument citation fixture.\n",
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "assistant-final",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The [artifact protocol](docs/architecture/s4-artifact-protocol.md#authority-and-durability) describes artifact updates. Read [the whole document](docs/architecture/s4-artifact-protocol.md) or [its lines](docs/architecture/s4-artifact-protocol.md#L1-L3). [Unsafe link](javascript:alert%281%29).",
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
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
    const citation = page.getByRole("link", { name: "artifact protocol", exact: true });
    await expect(citation).toBeVisible();
    await expect(page.getByRole("link", { name: "the whole document", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "its lines", exact: true })).toHaveAttribute(
      "href",
      "docs/architecture/s4-artifact-protocol.md#L1-L3",
    );
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await citation.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "docs/architecture/s4-artifact-protocol.md#authority-and-durability",
    );
    await citation.click();
    await expect
      .poll(
        () =>
          application.evaluate(async ({ webContents }) => {
            for (const contents of webContents.getAllWebContents()) {
              if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
              // Monaco renders spaces as non-breaking spaces in its token spans.
              if (
                await contents.executeJavaScript(
                  'document.body.innerText.replace(/\\s+/g, " ").includes("Document citation fixture.")',
                )
              )
                return true;
            }
            return false;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
