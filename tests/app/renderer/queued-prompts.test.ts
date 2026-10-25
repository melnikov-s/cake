import { expect, it } from "vitest";
import { queuedPrompts } from "../../../src/renderer/lib/queued-prompts";
import { researchOrigin } from "../../fixtures/subagent-report";
import { queuePart } from "./prompt-queue-workflow-fixture";

it("shares queue identity, payload and editability rules across conversation owners", () => {
  const human = queuePart(1, "**First**", { markdown: true });
  const steering = queuePart(2, "Steer", { lane: "steering" });
  const agent = queuePart(3, "Agent", { agent: true });
  const command = queuePart(4, "/compact", { command: "compact" });
  const untracked = { ...queuePart(5, "Extension"), queuedInput: undefined };
  const scheduled = {
    ...queuePart(6, "Scheduled"),
    scheduled: {
      version: 1 as const,
      id: "10000000-0000-4000-8000-000000000001",
      createdAt: "2026-01-01T00:00:00Z",
      sendAt: "2026-01-02T00:00:00Z",
    },
  };
  const report = { ...queuePart(7, "Report"), subagentReport: researchOrigin };
  const settled = { ...queuePart(8, "Settled"), deliveryState: undefined };
  const rows = queuedPrompts([
    human,
    steering,
    agent,
    command,
    untracked,
    scheduled,
    report,
    settled,
  ]);
  expect(rows.map((row) => [row.id, row.state, row.editable])).toEqual([
    ["queued-1", "queued", true],
    ["queued-2", "steering", true],
    ["queued-3", "queued", false],
    ["queued-4", "queued", false],
    ["queued-5", "queued", false],
    ["queued-6", "queued", false],
  ]);
  expect(rows[0]).toMatchObject({
    text: "**First**",
    itemId: human.queuedInput!.itemId,
    renderUserMessageAsMarkdown: true,
    attachments: [],
  });
  expect(rows[2]!.source).toEqual(agent.crossSession);
  expect(rows[3]!.command).toBe("compact");
  expect(rows[5]!.scheduled).toEqual(scheduled.scheduled);
});
