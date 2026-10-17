import type { Message } from "@earendil-works/pi-durable-ai";
import { expect, it } from "vitest";
import { durableContextInspection } from "../../../../src/services/pi-durable/durable-context-inspection";

it("projects the active memory frontier, instructions and recent messages without mixing retained history into the prompt", () => {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "Coordinator instructions\n\n<cake-chat-instructions>\nAlways ask before merging\n</cake-chat-instructions>",
      timestamp: 0,
    },
    {
      role: "user",
      content:
        "<chat>\n0+4|user: Keep changes small\n4+1|talk: Verified focused tests\n</chat>\n\n<current-time>Backend clock (UTC): 2026-01-01T00:00:00Z</current-time>",
      timestamp: 1,
    },
    { role: "user", content: "The current request", timestamp: 2 },
  ];
  const original = structuredClone(messages);
  const context = durableContextInspection(messages, "/scratch", messages[1]);
  expect(context.sources.find((source) => source.title === "System prompt")?.text).toBe(
    "Coordinator instructions",
  );
  expect(context.sources.find((source) => source.title === "Cake Chat instructions")?.text).toBe(
    "Always ask before merging",
  );
  expect(context.sources.find((source) => source.id === "memory")?.children).toEqual([
    expect.objectContaining({
      title: "user: Keep changes small",
      detail: { memoryId: 0, memoryCount: 4 },
    }),
    expect.objectContaining({
      title: "talk: Verified focused tests",
      detail: { memoryId: 4, memoryCount: 1 },
    }),
  ]);
  expect(context.sources.find((source) => source.id === "messages")?.children).toEqual([
    expect.objectContaining({ text: "The current request" }),
  ]);
  expect(context.sources.find((source) => source.title === "Clock")?.text).toContain("2026-01-01");
  expect(messages).toEqual(original);
});

it("keeps ordinary quoted memory markup readable as a message rather than inventing a memory range", () => {
  const content =
    "<chat>\n0+4|not an injected memory\n</chat>\n\n<current-time>Backend clock (UTC): 2026-01-01T00:00:00Z</current-time>";
  const context = durableContextInspection(
    [{ role: "user", content, timestamp: 1 }],
    "/scratch",
    undefined,
  );
  expect(context.sources).toEqual([
    { id: "messages", title: "Messages", children: [expect.objectContaining({ text: content })] },
  ]);
});
