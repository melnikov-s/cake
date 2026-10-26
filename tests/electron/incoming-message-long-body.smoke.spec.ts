import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
const longReport = [
  "## Approved PRs you can merge",
  "",
  ...Array.from({ length: 24 }, (_, index) =>
    [
      `${index + 1}. https://github.com/example/world/pull/${2305900 + index}: the PR maintainer lists open bot PRs once per run.`,
      `   - **Approvals:** two reviewers on the current commit \`d100e0${String(index).padStart(2, "0")}\``,
    ].join("\n"),
  ),
  "",
  "Final line of the long report.",
].join("\n");

test("an expanded long incoming message is fully reachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-incoming-long-"));
  const paths = {
    cakeHome: join(root, "cake"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("result-todo-done")!;
  await scenario.seed(paths, "dark");
  // Replace the short exact source response with a long Markdown report.
  const sessions = join(paths.cakeHome, "pi", "sessions");
  const [workspace] = await readdir(sessions);
  const directory = join(sessions, workspace!);
  const file = (await readdir(directory)).find((name) =>
    name.endsWith("3d4e5f6a-7b8c-4d9e-8f01-2a3b4c5d6e71.jsonl"),
  )!;
  const entries = (await readFile(join(directory, file), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const result = entries.find((entry) => entry.id === "build-result");
  result.message.content = [{ type: "text", text: longReport }];
  await writeFile(
    join(directory, file),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_HOME: paths.cakeHome,
      CAKE_ELECTRON_USER_DATA: paths.userData,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 1100),
    );
    await scenario.prepare(page, "dropdowns");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 800),
    );
    const card = page
      .locator('[data-slot="session-message"]')
      .filter({ has: page.getByRole("checkbox", { name: "Done: Fix the flaky build" }) });
    const toggle = card.locator('[data-slot="response-disclosure"]');
    const transcript = page.locator(".transcript").filter({ has: card });
    const offsetInTranscript = (locator: typeof toggle) =>
      locator.evaluate((node) => {
        const viewport = node.closest(".transcript")!.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return { top: rect.top - viewport.top, bottom: rect.bottom - viewport.bottom };
      });
    // Follow the bottom, then open the long message: its header stays in view.
    await transcript.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await toggle.click();
    const last = card.getByText("Final line of the long report.");
    await expect(last).toBeAttached();
    await expect.poll(async () => (await offsetInTranscript(toggle)).top).toBeGreaterThanOrEqual(0);
    // The open body never becomes its own scroll trap inside the card.
    const body = card.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
    expect(
      await body.evaluate((node) => node.scrollHeight - node.clientHeight),
    ).toBeLessThanOrEqual(1);
    // Wheeling over the card scrolls the transcript until the last line is readable.
    const box = (await toggle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 400);
        return (await offsetInTranscript(last)).bottom;
      })
      .toBeLessThanOrEqual(0);
    await expect(card.getByRole("checkbox", { name: "Done: Fix the flaky build" })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
