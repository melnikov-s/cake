/** @vitest-environment jsdom */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createLiveMessageProjector,
  projectSessionEntries,
} from "../../../src/services/pi/runtime/session-projection";
import { readFile, renderWorkLog } from "./work-log-presentation-workflow-fixture";

function assistant(thinking: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fixture",
    timestamp: 999_000,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

function saved(message: AssistantMessage) {
  return projectSessionEntries([
    {
      type: "message",
      id: "assistant",
      parentId: null,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    },
  ]);
}

async function revealReasoning(thinking: string, fixture: ReturnType<typeof renderWorkLog>) {
  if (thinking) {
    const summary = screen.getByText("Work log", { exact: true }).closest("summary");
    if (!summary) throw new Error("Missing work log disclosure");
    await fixture.user.click(summary);
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(["Inspect the file", ""])(
  "counts observed reasoning (%j), stops at thinking_end and keeps its frozen time through settlement",
  async (thinking) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    const message = assistant(thinking);
    const project = createLiveMessageProjector();
    project({ type: "message_start", message });
    const live = project({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
    });
    const elapsed = () => screen.getByLabelText("elapsed time").textContent;
    {
      using fixture = renderWorkLog(live, { streaming: true });
      await revealReasoning(thinking, fixture);
      // The request began earlier; we time only the reasoning actually observed here.
      expect(screen.queryByLabelText("elapsed time")).toBeNull();
      act(() => vi.advanceTimersByTime(1_000));
      expect(elapsed()).toBe("1s");
      fixture.publish(
        project({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: thinking,
            partial: message,
          },
        }),
        true,
      );
      act(() => vi.advanceTimersByTime(2_000));
      expect(elapsed()).toBe("1s");
      // Later answer streaming must not restart or extend the reasoning clock.
      const answer: AssistantMessage = {
        ...message,
        content: [...message.content, { type: "text", text: "Done" }],
        durationMs: 3_500,
      };
      fixture.publish(
        project({
          type: "message_update",
          message: answer,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 1,
            delta: "Done",
            partial: answer,
          },
        }),
        true,
      );
      act(() => vi.advanceTimersByTime(1_000));
      fixture.publish(project({ type: "message_end", message: answer }));
      fixture.publish(saved(answer));
      expect(elapsed()).toBe("1s");
      act(() => vi.advanceTimersByTime(5_000));
      expect(elapsed()).toBe("1s");
    }
    // A fresh view cannot recover a per-block duration from a response-wide duration.
    using reloaded = renderWorkLog(saved({ ...message, durationMs: 3_500 }));
    await revealReasoning(thinking, reloaded);
    expect(screen.queryByLabelText("elapsed time")).toBeNull();
    expect(reloaded).toBeDefined();
  },
);

it("freezes earlier reasoning blocks while a later block is streaming", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(1_000_000);
  const project = createLiveMessageProjector();
  const first = assistant("First thought");
  using fixture = renderWorkLog(
    project({
      type: "message_update",
      message: first,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "First thought",
        partial: first,
      },
    }),
    { streaming: true },
  );
  await revealReasoning("First thought", fixture);
  act(() => vi.advanceTimersByTime(2_000));
  const second: AssistantMessage = {
    ...first,
    content: [...first.content, { type: "thinking", thinking: "Next thought" }],
  };
  fixture.publish(
    project({
      type: "message_update",
      message: second,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: second },
    }),
    true,
  );
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getAllByLabelText("elapsed time").map((chip) => chip.textContent)).toEqual([
    "2s",
    "1s",
  ]);
});

it.each([0, 5, 999, 1_000])(
  "shows nested tool duration %sms only once it reaches a second",
  async (durationMs) => {
    using fixture = renderWorkLog([
      {
        ...readFile("parent"),
        nestedCalls: {
          calls: [{ ...readFile("child"), durationMs, outputAvailability: "live" }],
        },
      },
    ]);
    const summary = screen.getByText("Work log", { exact: true }).closest("summary");
    if (!summary) throw new Error("Missing work log disclosure");
    await fixture.user.click(summary);
    await fixture.user.click(screen.getByRole("button", { name: /read parent.ts/ }));
    expect(screen.queryByLabelText("elapsed time")?.textContent).toBe(
      durationMs < 1_000 ? undefined : "1s",
    );
  },
);
