import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { encodeCrossSessionMessage } from "../../src/contracts/conversations/cross-session-message";
import { messageReference } from "../../src/contracts/conversations/message-reference";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("selects mixed conversational entries once, in display order, only in the focused pane", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-message-keyboard-selection-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "message-keyboard-selection";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
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
  const entries: object[] = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
  ];
  let parentId: string | null = null;
  for (const turn of [1, 2, 3]) {
    entries.push({
      type: "message",
      id: `user-${turn}`,
      parentId,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: `Question ${turn}` }],
        timestamp: turn * 3,
      },
    });
    entries.push({
      type: "message",
      id: `assistant-${turn}`,
      parentId: `user-${turn}`,
      timestamp,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              `Answer ${turn}.`,
              ...(turn === 3
                ? [`[Full agent response](${messageReference(sessionId, "delivered-2")})`]
                : []),
              ...Array.from({ length: 8 }, () => "Long detail. ".repeat(30)),
            ].join("\n\n"),
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        usage,
        stopReason: "stop",
        timestamp: turn * 3 + 1,
      },
    });
    parentId = `assistant-${turn}`;
    if (turn < 3) {
      entries.push({
        type: "message",
        id: `delivered-${turn}`,
        parentId,
        timestamp,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: encodeCrossSessionMessage(`Delivered result ${turn}`, {
                version: 1,
                messageId: `00000000-0000-4000-8000-00000000000${turn}`,
                threadId: "00000000-0000-4000-8000-000000000003",
                sequence: turn,
                expectsResponse: false,
                sender: { sessionId: "sender", title: "Other session", kind: "project-session" },
              }),
            },
          ],
          timestamp: turn * 3 + 2,
        },
      });
      parentId = `delivered-${turn}`;
    }
  }
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
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
    const pane = page.locator('[data-slot="session-pane"]').first();
    const composer = pane.getByRole("combobox", { name: "Message", exact: true });
    const transcript = pane.locator(".transcript");
    const selected = pane.locator('[data-slot="transcript-item"][aria-current="true"]');
    const answer = (turn: number) =>
      pane.locator('[data-slot="transcript-item"]').filter({ hasText: `Answer ${turn}.` });
    await expect(answer(3)).toBeVisible({ timeout: 20_000 });
    // The same delivered entry also appears nested inside an expanded exact-source
    // preview. It must not become an extra keyboard stop.
    const source = answer(3).locator('[data-slot="message-source"]');
    await answer(3)
      .locator('[data-slot="session-message"] [data-slot="response-disclosure"]')
      .click();
    await expect(source).toContainText("Delivered result 2");
    await composer.click();
    await expect(composer).toBeFocused();

    // Empty composer: Up selects the newest conversational entry; focus stays put.
    await page.keyboard.press("ArrowUp");
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText("Answer 3.");
    await expect(composer).toBeFocused();
    // The ring outlines the message bubble only, not the action row beneath it.
    const boxShadow = (locator: typeof selected) =>
      locator.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(await boxShadow(selected)).toBe("none");
    expect(await boxShadow(selected.locator('[data-slot="message-content"]'))).toMatch(
      /0px 0px 0px 1px/,
    );

    const stops = [
      ["user-1", "text"],
      ["assistant-1", "text-0"],
      ["delivered-1", "text"],
      ["user-2", "text"],
      ["assistant-2", "text-0"],
      ["delivered-2", "text"],
      ["user-3", "text"],
      ["assistant-3", "text-0"],
    ].map(([entry, suffix]) => `entry-${entry}-${suffix}`);
    for (const id of stops.slice(0, -1).toReversed()) {
      await page.keyboard.press("ArrowUp");
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", id);
      await expectTopRevealed(transcript, selected);
    }
    // Up at the oldest keeps the first user entry selected.
    await page.keyboard.press("ArrowUp");
    await expect(selected).toHaveAttribute("data-transcript-anchor-id", stops[0]!);
    for (const id of stops.slice(1)) {
      await page.keyboard.press("ArrowDown");
      await expect(selected).toHaveAttribute("data-transcript-anchor-id", id);
    }
    await page.keyboard.press("ArrowDown");
    await expect(selected).toHaveCount(0);
    await expect(composer).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(selected).toHaveCount(0);

    // Escape clears ahead of the composer; typing clears and keeps the text.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("h");
    await expect(selected).toHaveCount(0);
    await expect(composer).toHaveValue("h");
    // A composer with text keeps its arrows.
    await page.keyboard.press("ArrowUp");
    await expect(selected).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.fill("first\nsecond");
    await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2));
    await composer.press("ArrowDown");
    // Native vertical caret navigation follows pixel position in this proportional
    // font, not necessarily the same character column on differently shaped lines.
    await expect
      .poll(() => composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart))
      .toBeGreaterThanOrEqual("first\n".length);
    await composer.press("ArrowUp");
    await expect
      .poll(() => composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart))
      .toBeLessThan("first\n".length);
    await expect(composer).toHaveValue("first\nsecond");
    await expect(composer).toBeFocused();
    await expect(selected).toHaveCount(0);
    await composer.fill("");

    // Pane-focus hotkeys keep their modified arrows.
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+ArrowUp" : "Control+Alt+ArrowUp",
    );
    await expect(selected).toHaveCount(0);

    // A click outside the selected message clears; a click inside keeps it.
    await page.keyboard.press("ArrowUp");
    await selected.getByText("Answer 3.").click();
    await expect(selected).toContainText("Answer 3.");
    await pane.getByText("Question 3").click();
    await expect(selected).toHaveCount(0);
    // The clicked transcript holds focus, so its pane keeps taking the keys.
    await expect(transcript).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(selected).toContainText("Answer 3.");
    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);

    // Only the pane that holds focus responds.
    await pane.getByRole("button", { name: "Split right" }).click();
    const panes = page.locator('[data-slot="session-pane"]');
    await expect(panes).toHaveCount(2);
    const secondComposer = panes.nth(1).getByLabel("Message");
    await expect(secondComposer).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(selected).toHaveCount(0);
    await composer.click();
    await page.keyboard.press("ArrowUp");
    await expect(selected).toContainText("Answer 3.");
    await expect(
      panes.nth(1).locator('[data-slot="transcript-item"][aria-current="true"]'),
    ).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

/** Waits for virtualization to mount and reveal the target in the transcript viewport. */
async function expectTopRevealed(transcript: Locator, item: Locator) {
  await expect
    .poll(async () => {
      const [viewport, bounds] = await Promise.all([transcript.boundingBox(), item.boundingBox()]);
      return Boolean(
        viewport && bounds && bounds.y >= viewport.y && bounds.y < viewport.y + viewport.height / 2,
      );
    })
    .toBe(true);
}
