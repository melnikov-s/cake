import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type Locator } from "@playwright/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry, AssistantEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { openProjectChat, openSession } from "./fixtures/workspace-navigation";
import { pointAt } from "./fixtures/pointer";
import { writeFixtureModels } from "./fixtures/fixture-model";

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
    // A Session link's purpose glyph names the link (b6cd0f2d).
    const linkedAnswerName = coordinator ? "Linked answer" : "User Session f80c961e";
    const linkedRequestName = coordinator ? "Linked request" : "User Session Linked request";
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
    // The saved model must resolve: the unavailable-model notice under the transcript
    // would otherwise grow it (and move the followed end) while the reader navigates.
    await writeFixtureModels(cakeHome, {
      baseUrl: "http://127.0.0.1:9/v1",
      provider: "anthropic",
      modelId: "fixture",
    });
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
      // Launch always opens global Cake Chat (40566199); then explicitly select the
      // surface under test through its real navigation.
      await expect(
        page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      if (surface === "Project Chat") await openProjectChat(page, "project");
      if (surface === "Project Session") await openSession(page, "Question 1");
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
      await page.keyboard.press("ArrowUp");
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
      const identityLink = selected.getByRole("link", { name: linkedAnswerName, exact: true });
      const destination = `cake://session/${encodeURIComponent(sessionId)}?message=${assistants.get(6)}`;
      await expect(identityLink).toHaveAttribute("href", destination);
      // Point at the painted link; a programmatic scroll-into-view is not reader input.
      await pointAt(page, identityLink);
      // Session link tooltips list the label and Session title before the reference (5c284c46).
      await expect(page.getByRole("tooltip")).toContainText(destination);
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
      // The reader keeps using the keyboard where the link click left focus; clicking
      // the composer would intentionally clear the selection.
      await page.keyboard.press("ArrowUp");
      await expect(selected).toContainText("Question 6");
      await expectRevealed(transcript, selected);
      await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText("Answer 6.");
      // Rapid navigation crosses unmounted, variable-height rows, then reverses.
      for (let index = 0; index < 15; index++) await page.keyboard.press("ArrowUp");
      await expect(selected).toContainText("Question 1");
      for (let index = 0; index < 23; index++) await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText("Answer 12.");
      await expectRevealed(transcript, selected);
      await selected.getByRole("link", { name: linkedRequestName, exact: true }).click();
      await expect(selected).toContainText("Question 6");
      await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText("Answer 6.");
      await expectRevealed(transcript, selected);
      // Clearing past newest returns focus to writing without scrolling, and
      // supersedes any virtualizer retry for an earlier target.
      for (let index = 0; index < 13; index++) await page.keyboard.press("ArrowDown");
      await expect(selected).toHaveCount(0);
      await expect(composer).toBeFocused();
      // Let the list's measurement frames run; an obsolete target must not
      // move the transcript after the selection ends.
      const tops = await transcript.evaluate(async (element) => {
        const tops: string[] = [];
        for (let frame = 0; frame < 20; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          tops.push(`${element.scrollTop}/${element.scrollHeight}/${element.clientHeight}`);
        }
        return tops;
      });
      expect(new Set(tops).size, tops.join(" ")).toBe(1);
      const behaviors = await page.evaluate(
        () => Reflect.get(window, "messageNavigationBehaviors") as string[],
      );
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).not.toContain("smooth");
      await page.keyboard.press("ArrowUp");
      await expect(selected).toContainText("Answer 12.");
      await page.keyboard.press("Escape");
      await page.keyboard.press("x");
      await page.keyboard.press("ArrowUp");
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
          const viewport = element.getBoundingClientRect();
          // Recycled virtual rows need not be in DOM order. Pick the first painted row.
          const anchor = [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")]
            .map((row) => ({
              id: row.dataset.transcriptAnchorId,
              bounds: row.getBoundingClientRect(),
            }))
            .filter(
              ({ bounds }) => bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom,
            )
            .sort((left, right) => left.bounds.top - right.bounds.top)[0]!;
          return {
            id: anchor.id,
            offset: anchor.bounds.top - viewport.top,
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
