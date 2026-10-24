import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../../tests/fixtures/window-state";
import type { VisualCaptureTheme } from "./arguments";

export const toolCallRowsScenario = {
  name: "tool-call-rows",
  description: "Selectable tool calls, spaced path links, home display and rounded durations",
  states: ["default"],
  async seed(
    paths: { cakeHome: string; project: string; userData: string },
    theme: VisualCaptureTheme,
  ) {
    const sessionId = "tool-call-rows";
    const timestamp = new Date(0).toISOString();
    const directory = cakeWorkspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(directory, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(join(paths.project, "example.ts"), "export const example = 1;\n");
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowState({ project: paths.project, sessionId, theme }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: paths.project, name: "Tool rows", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
        trustedProjectPaths: [],
      }),
    );
    const calls = [
      {
        id: "home",
        name: "read",
        arguments: { path: join(homedir(), ".pi/agent/example.md") },
        durationMs: 0,
      },
      {
        id: "prefix",
        name: "read",
        arguments: { path: `${homedir()}-other/example.md` },
        durationMs: 49,
      },
      {
        id: "project",
        name: "read",
        arguments: { path: join(paths.project, "example.ts") },
        durationMs: 50,
      },
      {
        id: "bash",
        name: "bash",
        arguments: { command: "printf 'tool calls are selectable'" },
        durationMs: 1200,
      },
    ];
    const entries: object[] = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Inspect the tool calls.", timestamp: 0 },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp,
        message: {
          role: "assistant",
          content: [
            ...calls.map(({ id, name, arguments: args }) => ({
              type: "toolCall",
              id,
              name,
              arguments: args,
            })),
            { type: "thinking", thinking: "" },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          stopReason: "toolUse",
          timestamp: 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];
    let parentId = "assistant";
    for (const call of calls) {
      const id = `result-${call.id}`;
      entries.push({
        type: "message",
        id,
        parentId,
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: "Tool result remains expandable." }],
          isError: false,
          timestamp: 2,
          durationMs: call.durationMs,
        },
      });
      parentId = id;
    }
    await writeFile(
      join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
  },
  async prepare(page: Page) {
    const group = page.locator('[data-slot="activity-group"]');
    await group.locator(":scope > summary").click();
    await expect(
      group.getByRole("button", { name: "~/.pi/agent/example.md", exact: true }),
    ).toBeVisible();
    await page.waitForFunction(() => document.fonts.status === "loaded");
  },
  region(page: Page) {
    return page.locator('[data-slot="activity-group"]');
  },
};
