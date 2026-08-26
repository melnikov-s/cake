import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function sessionTranscript(sessionId: string, project: string, title: string) {
  const timestamp = new Date(0).toISOString();
  const entries: Array<Record<string, unknown>> = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
  ];
  let parentId: string | null = null;
  for (let index = 0; index < 48; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const id = `${sessionId}-${index}`;
    const body = `${title} transcript item ${index}. ${"This line gives the virtualized message a distinct height. ".repeat((index % 6) + 1)}`;
    const text =
      index === 0
        ? title
        : index % 5 === 1
          ? `${body}\n\n\`\`\`ts\n${Array.from({ length: (index % 4) + 2 }, (_, line) => `const marker${index}_${line} = ${line};`).join("\n")}\n\`\`\``
          : body;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp,
      message:
        role === "user"
          ? { role, content: [{ type: "text", text }], timestamp: index }
          : {
              role,
              content: [{ type: "text", text }],
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
              timestamp: index,
            },
    });
    parentId = id;
  }
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function transcriptAnchor(transcript: Locator) {
  return transcript.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const item = Array.from(element.querySelectorAll<HTMLElement>(".transcript-item")).find(
      (candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1,
    );
    if (!item) throw new Error("No visible transcript item");
    return {
      text: item.textContent,
      offset: item.getBoundingClientRect().top - viewportTop,
      scrollTop: element.scrollTop,
    };
  });
}

async function expectRestoredAnchor(
  transcript: Locator,
  saved: Awaited<ReturnType<typeof transcriptAnchor>>,
) {
  await expect
    .poll(async () => {
      try {
        const restored = await transcriptAnchor(transcript);
        return {
          textMatches: restored.text === saved.text,
          offsetDifference: Math.abs(restored.offset - saved.offset),
          scrollDifference: Math.abs(restored.scrollTop - saved.scrollTop),
        };
      } catch {
        return {
          textMatches: false,
          offsetDifference: Number.POSITIVE_INFINITY,
          scrollDifference: Number.POSITIVE_INFINITY,
        };
      }
    })
    .toEqual({ textMatches: true, offsetDifference: 0, scrollDifference: 0 });
}

test("restores a session's virtualized transcript position after leaving and switching sessions", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-scroll-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const firstSessionId = "scroll-session-first";
  const secondSessionId = "scroll-session-second";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: firstSessionId,
      activeConversation: {
        kind: "project-session",
        workspacePath: project,
        sessionId: firstSessionId,
      },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      resolvedSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await Promise.all([
    writeFile(
      join(sessionDirectory, `${firstSessionId}.jsonl`),
      sessionTranscript(firstSessionId, project, "First scroll fixture"),
    ),
    writeFile(
      join(sessionDirectory, `${secondSessionId}.jsonl`),
      sessionTranscript(secondSessionId, project, "Second scroll fixture"),
    ),
  ]);

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
    const transcript = page.locator(".transcript");
    const firstSession = page.locator(`.session-item[data-session-id="${firstSessionId}"]`);
    const secondSession = page.locator(`.session-item[data-session-id="${secondSessionId}"]`);
    await expect(transcript).toBeVisible({ timeout: 20_000 });
    await expect(firstSession).toHaveClass(/active/);
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(3_000);
    await page.waitForTimeout(500);
    const bottomPosition = await transcript.evaluate((element) => element.scrollTop);
    await transcript.hover();
    await page.mouse.wheel(0, -2_000);
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeLessThan(bottomPosition - 500);
    await page.waitForTimeout(150);
    const savedAnchor = await transcriptAnchor(transcript);

    await page.locator(".sidebar").getByLabel("Open settings").click();
    await page.getByLabel("Back to chat").click();
    await expectRestoredAnchor(transcript, savedAnchor);

    await secondSession.locator(".session-row").click();
    await expect(secondSession).toHaveClass(/active/);
    await firstSession.locator(".session-row").click();
    await expect(firstSession).toHaveClass(/active/);

    await expectRestoredAnchor(transcript, savedAnchor);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
