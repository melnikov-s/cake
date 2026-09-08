import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

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
    const item = Array.from(
      element.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
    ).find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1);
    if (!item) throw new Error("No visible transcript item");
    return {
      text: item.textContent,
      offset: item.getBoundingClientRect().top - viewportTop,
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
        };
      } catch {
        return {
          textMatches: false,
          offsetDifference: Number.POSITIVE_INFINITY,
        };
      }
    })
    .toEqual({ textMatches: true, offsetDifference: 0 });
}

for (const scenario of [
  "restores session position",
  "follows the full bottom and isolates nested scrolling",
] as const) {
  test(scenario, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-scroll-smoke-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const firstSessionId = "scroll-session-first";
    const secondSessionId = "scroll-session-second";
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
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
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
        trustedProjectPaths: [],
      }),
    );
    await Promise.all([
      writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${firstSessionId}.jsonl`),
        sessionTranscript(firstSessionId, project, "First scroll fixture"),
      ),
      writeFile(
        join(sessionDirectory, `1970-01-01T00-00-01-000Z_${secondSessionId}.jsonl`),
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
        .poll(() =>
          transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);

      const composer = page.getByRole("combobox", { name: "Message" });
      await composer.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
      await expect(page.locator('[data-slot="transcript-item"]').last()).toBeVisible();
      await expect
        .poll(async () => {
          const lastMessageBottom = await page
            .locator('[data-slot="transcript-item"]')
            .last()
            .evaluate((element) => element.getBoundingClientRect().bottom);
          const composerTop = await page
            .locator(".workbench-composer")
            .evaluate((element) => element.getBoundingClientRect().top);
          return Math.abs(lastMessageBottom - composerTop);
        })
        .toBeLessThanOrEqual(2);
      await composer.fill("");

      if (scenario === "follows the full bottom and isolates nested scrolling") {
        // A nested overflow surface consumes its own wheel input. It must not
        // disable transcript following when later content changes the outer height.
        await transcript.evaluate((element) => {
          const footer = element.querySelector("[data-viewport-type]")?.lastElementChild;
          if (!(footer instanceof HTMLElement)) throw new Error("Missing transcript footer");
          const nested = document.createElement("div");
          nested.dataset.testid = "nested-scroll-fixture";
          nested.style.cssText = "height: 100px; overflow: auto; overscroll-behavior: contain";
          const content = document.createElement("div");
          content.style.height = "800px";
          content.textContent = "Nested scroll fixture";
          nested.append(content);
          footer.prepend(nested);
        });
        const nested = page.getByTestId("nested-scroll-fixture");
        await expect(nested).toBeVisible();
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await nested.hover();
        await page.mouse.wheel(0, 150);
        await expect.poll(() => nested.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await page.waitForTimeout(250);
        await nested.evaluate((element) => {
          element.style.height = "200px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        // At the nested boundary, containment still prevents scroll chaining.
        await nested.evaluate((element) => {
          element.scrollTop = 0;
        });
        await nested.hover();
        await page.mouse.wheel(0, -150);
        await nested.evaluate((element) => {
          element.style.height = "250px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await nested.evaluate((element) => element.remove());
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      }

      await page.waitForTimeout(500);
      const bottomPosition = await transcript.evaluate((element) => element.scrollTop);
      await transcript.hover();
      await page.mouse.wheel(0, -2_000);
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollTop))
        .toBeLessThan(bottomPosition - 500);
      await page.waitForTimeout(500);
      const savedAnchor = await transcriptAnchor(transcript);

      if (scenario === "restores session position") {
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
        await page.getByLabel("Back to chat").click();
        await expectRestoredAnchor(transcript, savedAnchor);

        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);

        await expectRestoredAnchor(transcript, savedAnchor);

        await transcript.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await page.waitForTimeout(150);
        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);

        await transcript.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event("scroll"));
        });
        await page.waitForTimeout(150);
        await secondSession.locator(".session-row").click();
        await expect(secondSession).toHaveClass(/active/);
        await firstSession.locator(".session-row").click();
        await expect(firstSession).toHaveClass(/active/);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);

        // Another session settling rerenders the application shell. Exercise the
        // same parent-render boundary after Virtuoso has restored this transcript.
        await page
          .getByRole("complementary")
          .getByRole("button", { name: "Toggle sidebar" })
          .click();
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(500);
      } else {
        // Resizing the composer while reading history must not pull us back down.
        await composer.fill("Line one\nLine two\nLine three\nLine four");
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeGreaterThan(500);
        await composer.fill("");

        // Submission must reach the real DOM bottom from a mid-history
        // position, including the optimistic message, loading row and error footer.
        await composer.click();
        await expect(composer).toBeFocused();
        await page.keyboard.type("Scroll submission fixture");
        await expect(composer).toHaveValue("Scroll submission fixture");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await page.waitForTimeout(1500);
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);

        // Exercise delayed streaming/layout growth after submission has settled.
        const lastItem = transcript.locator('[data-slot="transcript-item"]').last();
        for (const height of [400, 800, 200, 600]) {
          await lastItem.evaluate((element, height) => {
            element.style.minHeight = `${height}px`;
          }, height);
          await expect
            .poll(() =>
              transcript.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeLessThanOrEqual(1);
        }
        // A downward wheel at the outer bottom may not emit a native scroll event.
        await transcript.hover({ position: { x: 20, y: 200 } });
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(300);
        await lastItem.evaluate((element) => {
          element.style.minHeight = "900px";
        });
        await expect
          .poll(() =>
            transcript.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      }
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
