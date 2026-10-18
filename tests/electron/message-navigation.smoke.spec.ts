import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry, AssistantEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

for (const surface of ["Project Session", "Cake Chat", "Project Chat"] as const) {
  test(`${surface}: instant virtualized arrows continue from the correct linked message`, async () => {
    test.setTimeout(90_000);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-instant-message-navigation-"));
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const userData = join(temporaryRoot, "user-data");
    const projectId = "01957936-0000-7000-8000-0001f80c961e";
    const coordinator = surface !== "Project Session";
    const linkedAnswerLabel = coordinator ? "Linked answer" : "f80c961e";
    const sessionId =
      surface === "Project Chat"
        ? `project-chat:${createHash("sha256").update(project).digest("hex")}`
        : surface === "Cake Chat"
          ? CAKE_CHAT_SESSION_ID
          : projectId;
    const timestamp = new Date(0).toISOString();
    const directory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(userData, { recursive: true }),
      mkdir(directory, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId: projectId, theme: "dark" }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
        trustedProjectPaths: [],
      }),
    );
    const entries: object[] = [
      { type: "session", version: 3, id: projectId, timestamp, cwd: project },
    ];
    let parentId: string | null = null;
    const users = new Map<number, string>();
    const assistants = new Map<number, string>();
    const durableDirectory =
      surface === "Project Chat"
        ? join(cakeHome, "pi", "project-chats", sessionId.slice("project-chat:".length))
        : join(cakeHome, "pi", "global-chat");
    await mkdir(durableDirectory, { recursive: true });
    const storage = await openNodeSqliteStorage(join(durableDirectory, "coordinator.sqlite"));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit(async (tx) => {
        for (let turn = 1; turn <= 12; turn++) {
          const user = {
            role: "user" as const,
            content: [{ type: "text" as const, text: `Question ${turn}` }],
            timestamp: turn * 2,
          };
          const userEntry = await tx.appendEntry(UserEntry, root.id, { model: [user] });
          users.set(turn, coordinator ? String(userEntry.id) : `user-${turn}`);
          const links =
            turn === 12
              ? `\n\n[${linkedAnswerLabel}](cake://session/${sessionId}?message=${assistants.get(6)}) · [Linked request](cake://session/${sessionId}?message=${users.get(6)})`
              : "";
          const text = [
            `Answer ${turn}.${links}`,
            ...Array.from({ length: turn % 2 === 0 ? 8 : 3 }, () => "Long detail. ".repeat(30)),
          ].join("\n\n");
          const assistant = {
            role: "assistant" as const,
            content: [
              { type: "thinking" as const, thinking: `Reasoning ${turn}` },
              { type: "text" as const, text },
            ],
            timestamp: turn * 2 + 1,
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            stopReason: "stop" as const,
            usage,
          };
          const assistantEntry = await tx.appendEntry(AssistantEntry, root.id, {
            model: [assistant],
          });
          assistants.set(turn, coordinator ? String(assistantEntry.id) : `assistant-${turn}`);
          entries.push(
            { type: "message", id: `user-${turn}`, parentId, timestamp, message: user },
            {
              type: "message",
              id: `assistant-${turn}`,
              parentId: `user-${turn}`,
              timestamp,
              message: assistant,
            },
          );
          parentId = `assistant-${turn}`;
        }
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
    await writeFile(
      join(directory, `1970-01-01T00-00-00-000Z_${projectId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
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
      // Wait for startup restoration/hydration before switching surfaces or sending keys.
      await expect(page.getByText("Answer 12.", { exact: true })).toBeVisible({ timeout: 20_000 });
      if (surface === "Cake Chat")
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      if (surface === "Project Chat")
        await page
          .getByRole("button", { name: "Open Project Chat for project", exact: true })
          .click();
      const composer = page.getByRole("combobox", {
        name: coordinator ? `Message ${surface}` : "Message",
        exact: true,
      });
      const pane = page.locator('[data-slot="chat"]').filter({ has: composer });
      const transcript = pane.locator(".transcript");
      const selected = pane.locator('[data-slot="transcript-item"][aria-current="true"]');
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await expect(pane.getByText("Answer 12.", { exact: true })).toBeVisible({ timeout: 20_000 });
      await composer.click();
      await expect(composer).toBeFocused();
      // Record native scroll requests and resize errors without replacing the
      // browser's measurements or suppressing its error events.
      await page.evaluate(() => {
        const errors: string[] = [];
        Reflect.set(window, "navigationRendererErrors", errors);
        window.addEventListener("error", (event) => errors.push(event.message));
        const original = Element.prototype.scrollTo;
        const behaviors: string[] = [];
        Object.assign(window, { messageNavigationBehaviors: behaviors });
        Element.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
          if (this.matches(".transcript"))
            behaviors.push(typeof options === "object" ? (options.behavior ?? "auto") : "auto");
          const scrollTo = original.bind(this);
          if (typeof options === "number") scrollTo(options, y!);
          else scrollTo(options);
        };
      });
      await composer.press("ArrowUp");
      await expect(selected).toContainText("Answer 12.");
      await expectRevealed(transcript, selected);
      // Inspect completed rendering updates, not only eventual alignment. Once
      // the offscreen target renders, no painted frame may expose its estimate.
      await transcript.evaluate((element) => {
        const offsets: number[] = [];
        let frame: number;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sample = () => {
          timer = setTimeout(() => {
            const target = element.querySelector<HTMLElement>(
              '[data-slot="transcript-item"][aria-current="true"]',
            );
            if (
              target?.textContent?.includes("Answer 6.") &&
              getComputedStyle(target).visibility === "visible"
            )
              offsets.push(
                target.getBoundingClientRect().top - element.getBoundingClientRect().top,
              );
            frame = requestAnimationFrame(sample);
          }, 0);
        };
        frame = requestAnimationFrame(sample);
        Object.assign(element, {
          stopNavigationFrames: () => {
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            return offsets;
          },
        });
      });
      const identityLink = selected.getByRole("link", { name: linkedAnswerLabel, exact: true });
      const destination = `cake://session/${encodeURIComponent(sessionId)}?message=${assistants.get(6)}`;
      await expect(identityLink).toHaveAttribute("href", destination);
      await identityLink.hover();
      await expect(page.getByRole("tooltip", { name: destination, exact: true })).toBeVisible();
      await identityLink.click();
      await expect(selected).toContainText("Answer 6.");
      await expectRevealed(transcript, selected);
      await transcript.evaluate(async () => {
        for (let frame = 0; frame < 6; frame++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      });
      const linkedOffsets = await transcript.evaluate((element) =>
        (element as HTMLElement & { stopNavigationFrames(): number[] }).stopNavigationFrames(),
      );
      expect(linkedOffsets.length).toBeGreaterThan(0);
      expect(linkedOffsets.every((offset) => Math.abs(offset - 16) <= 1)).toBe(true);
      // Focus, not a pointer click: clicking the composer intentionally clears selection.
      await composer.focus();
      await composer.press("ArrowUp");
      await expect(selected).toContainText("Answer 5.");
      await expectRevealed(transcript, selected);
      await composer.press("ArrowDown");
      await expect(selected).toContainText("Answer 6.");
      // Rapid navigation crosses unmounted, variable-height rows, then reverses.
      for (let index = 0; index < 9; index++) await composer.press("ArrowUp");
      await expect(selected).toContainText("Answer 1.");
      for (let index = 0; index < 11; index++) await composer.press("ArrowDown");
      await expect(selected).toContainText("Answer 12.");
      await expectRevealed(transcript, selected);
      await selected.getByRole("link", { name: "Linked request", exact: true }).click();
      await expect(selected).toContainText("Question 6");
      await composer.focus();
      await composer.press("ArrowDown");
      await expect(selected).toContainText("Answer 6.");
      await expectRevealed(transcript, selected);
      // Clearing past newest supersedes any virtualizer retry for an earlier target.
      for (let index = 0; index < 7; index++) await composer.press("ArrowDown");
      await expect(selected).toHaveCount(0);
      await expect(composer).toBeFocused();
      await expect
        .poll(() =>
          transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      // Let Virtuoso's measurement-retry frames run; an obsolete target must not
      // pull the transcript away from the writing position after it reaches bottom.
      expect(
        await transcript.evaluate(async (element) => {
          const gaps: number[] = [];
          for (let frame = 0; frame < 20; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            gaps.push(element.scrollHeight - element.clientHeight - element.scrollTop);
          }
          return Math.max(...gaps);
        }),
      ).toBeLessThanOrEqual(1);
      const behaviors = await page.evaluate(
        () => Reflect.get(window, "messageNavigationBehaviors") as string[],
      );
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).not.toContain("smooth");
      await composer.press("ArrowUp");
      await expect(selected).toContainText("Answer 12.");
      await composer.press("Escape");
      await composer.press("x");
      await composer.press("ArrowUp");
      await expect(selected).toHaveCount(0);
      await expect(composer).toHaveValue("x");
      await expect(pane.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      // All three real product surfaces share the same reader ownership, not
      // only explicit navigation. Dock/layout bursts must not reclaim it.
      await transcript.hover({ position: { x: 20, y: 200 } });
      await transcript.evaluate((element) => {
        element.dataset.readingSettled = "false";
        element.addEventListener(
          "scrollend",
          () => {
            element.dataset.readingSettled = "true";
          },
          { once: true },
        );
      });
      await page.mouse.wheel(0, -250);
      await expect(transcript).toHaveAttribute("data-reading-settled", "true");
      const readingAnchor = () =>
        transcript.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = [
            ...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]"),
          ].find((row) => row.getBoundingClientRect().bottom > top + 1)!;
          return {
            id: row.dataset.transcriptAnchorId,
            offset: row.getBoundingClientRect().top - top,
            scrollTop: element.scrollTop,
          };
        });
      const saved = await readingAnchor();
      for (const lines of [4, 8, 1, 5]) {
        await composer.fill(Array.from({ length: lines }, () => "Draft line").join("\n"));
        await expect.poll(readingAnchor).toEqual(saved);
      }
      expect(await page.evaluate(() => Reflect.get(window, "navigationRendererErrors"))).toEqual(
        [],
      );
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

async function expectRevealed(transcript: Locator, item: Locator) {
  await expect
    .poll(async () => {
      const [viewport, bounds] = await Promise.all([transcript.boundingBox(), item.boundingBox()]);
      return Boolean(
        viewport && bounds && bounds.y >= viewport.y && bounds.y < viewport.y + viewport.height / 2,
      );
    })
    .toBe(true);
}
