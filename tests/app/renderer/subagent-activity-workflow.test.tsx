/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queuePart } from "./prompt-queue-workflow-fixture";
import { emptyProjectTodos } from "../../../src/contracts/projects/project-todos";
import type { Client } from "../../../src/renderer/client/Client";
import {
  handleId,
  parentSessionId,
  renderSubagentActivity,
  workerActivity,
  workerTranscript,
} from "./subagent-activity-workflow-fixture";

afterEach(cleanup);

async function openWorkerChat(user: ReturnType<typeof renderSubagentActivity>["user"]) {
  const summary = (await screen.findByText("Work log")).closest("summary");
  if (!summary) throw new Error("Missing work log disclosure");
  await user.click(summary);
  await user.click(await screen.findByRole("button", { name: "Open subagent chat" }));
  return screen.getByRole("complementary", { name: "Subagent" });
}

describe("Subagent activity workflow", () => {
  it("shows the worker's resolved model and its live context usage in the subagent chat", async () => {
    const usage = (tokens: number) => ({
      tokens: {
        input: 2,
        output: 2_338,
        cacheRead: tokens,
        cacheWrite: 970,
        total: tokens + 3_310,
      },
      cost: 5.12,
      context: {
        tokens: tokens + 3_310,
        contextWindow: 250_000,
        percent: (tokens + 3_310) / 2_500,
      },
    });
    const activity = workerActivity({
      resolvedModel: {
        requested: "current",
        source: "current",
        provider: "anthropic-250k-prefer-using-this-one",
        modelId: "claude-opus-5-5",
        thinkingLevel: "xhigh",
        fallbacks: [],
      },
      fastMode: true,
      usage: usage(120_000),
    });
    using fixture = renderSubagentActivity({ activity, parts: workerTranscript() });
    const panel = within(await openWorkerChat(fixture.user));
    const model = panel.getByLabelText(
      "Model: anthropic-250k-prefer-using-this-one/claude-opus-5-5 \u00b7 Xhigh reasoning \u00b7 Fast mode",
    );
    expect(model.textContent).toBe("claude-opus-5-5\u00b7 Xhigh\u00b7 Fast");
    expect(await panel.findByLabelText(/^49% context used; 123k \/ 250k tokens/)).toBeDefined();

    // Usage follows the running worker, as it does in a normal session.
    fixture.publish({
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: { ...activity, revision: 2, usage: usage(242_074) },
    });
    expect(await panel.findByLabelText(/^98% context used; 245k \/ 250k tokens/)).toBeDefined();

    // Released history has no composer, but still says what model did the work.
    fixture.publish({ _tag: "Removed", revision: 3, parentSessionId, handleId });
    await waitFor(() =>
      expect(panel.queryByRole("combobox", { name: "Message subagent" })).toBeNull(),
    );
    expect(
      panel.getByLabelText(/^Model: anthropic-250k-prefer-using-this-one\/claude-opus-5-5/),
    ).toBeDefined();
  });

  it("queues busy human input, prompts after completion, stops and preserves released history", async () => {
    const steer = vi.fn<Client["subagents"]["steer"]>(async () => undefined);
    const prompt = vi.fn<Client["subagents"]["prompt"]>(async () => undefined);
    const submit = vi.fn<Client["subagents"]["submit"]>(async () => ({ turnId: "human-turn" }));
    const abort = vi.fn<Client["subagents"]["abort"]>(async () => undefined);
    using fixture = renderSubagentActivity({
      client: { subagents: { steer, prompt, submit, abort } },
      activity: workerActivity(),
      parts: workerTranscript(),
    });
    const panel = await openWorkerChat(fixture.user);
    expect(await within(panel).findByText("Inspecting now")).toBeDefined();
    const input = within(panel).getByRole("combobox", { name: "Message subagent" });
    expect(input.getAttribute("placeholder")).toBe("Queue a message…");
    await fixture.user.type(input, "  Check cancellation too  ");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        {
          parentSessionId,
          handleId,
          text: "Check cancellation too",
          renderUserMessageAsMarkdown: false,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    await fixture.user.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(abort).toHaveBeenCalledWith(
        { parentSessionId, handleId },
        { signal: expect.any(AbortSignal) },
      ),
    );

    // The authority may complete before handling Stop; its update determines the UI.
    const completed = workerActivity({
      revision: 2,
      status: "complete",
      streaming: false,
      parts: [
        {
          id: "child-answer",
          kind: "text",
          role: "assistant",
          text: "Cancellation boundary checked.",
          status: "complete",
        },
      ],
    });
    fixture.publish(
      { _tag: "Activity", revision: 2, parentSessionId, activity: completed },
      workerTranscript(completed),
    );
    expect(await within(panel).findByText("Cancellation boundary checked.")).toBeDefined();
    expect(within(panel).getByText("complete")).toBeDefined();
    expect(input.getAttribute("placeholder")).toBe("Message this subagent…");
    expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
    await fixture.user.type(input, "One follow-up");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        { parentSessionId, handleId, text: "One follow-up", renderUserMessageAsMarkdown: false },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(steer).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();

    fixture.publish({ _tag: "Removed", revision: 3, parentSessionId, handleId });
    expect(await within(panel).findByText("complete · Resources released")).toBeDefined();
    expect(within(panel).getByText("Cancellation boundary checked.")).toBeDefined();
    expect(within(panel).queryByRole("combobox", { name: "Message subagent" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows accepted pre-start follow-ups with cancellation but waits for Pi before steering", async () => {
    const pending = queuePart(1, "Before worker starts");
    const editQueued = vi.fn<Client["subagents"]["editQueued"]>(async () => undefined);
    using fixture = renderSubagentActivity({
      client: { subagents: { editQueued } },
      activity: workerActivity({ status: "queued", streaming: false, parts: [pending] }),
      parts: workerTranscript(),
    });
    const panel = within(await openWorkerChat(fixture.user));
    expect(panel.getByText("Before worker starts")).toBeDefined();
    expect(
      panel.queryByRole("button", { name: "Send now as steering: Before worker starts" }),
    ).toBeNull();
    await fixture.user.click(
      panel.getByRole("button", { name: "Cancel queued message: Before worker starts" }),
    );
    await waitFor(() =>
      expect(editQueued).toHaveBeenCalledWith(
        {
          parentSessionId,
          handleId,
          partId: pending.id,
          itemId: pending.queuedInput!.itemId,
          operation: "remove",
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    fixture.publish({
      _tag: "Activity",
      revision: 2,
      parentSessionId,
      activity: workerActivity({ revision: 2, parts: [pending] }),
    });
    expect(
      await panel.findByRole("button", { name: "Send now as steering: Before worker starts" }),
    ).toBeDefined();
  });

  it("uses shared queue controls for explicit steering and stop-and-send without losing the other message", async () => {
    const first = {
      ...queuePart(1, "First follow-up"),
      queuedInput: {
        ...queuePart(1, "First follow-up").queuedInput!,
        turnId: "30000000-0000-4000-8000-000000000001",
      },
    };
    const second = queuePart(2, "Second follow-up");
    const editQueued = vi.fn<Client["subagents"]["editQueued"]>(async ({ operation }) => {
      fixture.publish({
        _tag: "Activity",
        revision: operation === "steer" ? 2 : 3,
        parentSessionId,
        activity: workerActivity({
          revision: operation === "steer" ? 2 : 3,
          parts:
            operation === "steer" ? [{ ...first, deliveryState: "steering" }, second] : [second],
        }),
      });
    });
    using fixture = renderSubagentActivity({
      client: { subagents: { editQueued } },
      activity: workerActivity({ parts: [first, second] }),
      parts: workerTranscript(),
    });
    const panel = await openWorkerChat(fixture.user);
    const queue = within(panel).getByRole("list", { name: "Queued prompts" });
    expect(
      within(queue)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("First follow-up"),
      expect.stringContaining("Second follow-up"),
    ]);
    await fixture.user.click(
      within(queue).getByRole("button", { name: "Send now as steering: First follow-up" }),
    );
    await waitFor(() =>
      expect(editQueued).toHaveBeenCalledWith(
        {
          parentSessionId,
          handleId,
          partId: first.id,
          operation: "steer",
          itemId: first.queuedInput.itemId,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    await fixture.user.click(
      within(queue).getByRole("button", { name: "Stop and send now: First follow-up" }),
    );
    await waitFor(() =>
      expect(editQueued).toHaveBeenCalledWith(
        {
          parentSessionId,
          handleId,
          partId: first.id,
          operation: "send-now",
          itemId: first.queuedInput.itemId,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(within(queue).getAllByRole("listitem")).toHaveLength(1);
    expect(within(queue).getByText("Second follow-up")).toBeDefined();
  });

  it("retains a failed human Markdown draft and queued message while showing command errors", async () => {
    const submit = vi
      .fn<Client["subagents"]["submit"]>()
      .mockRejectedValueOnce(new Error("Worker admission failed"))
      .mockResolvedValue({ turnId: "human" });
    const editQueued = vi.fn<Client["subagents"]["editQueued"]>(async () => {
      throw new Error("Queue update failed");
    });
    using fixture = renderSubagentActivity({
      client: { subagents: { submit, editQueued } },
      activity: workerActivity({ parts: [queuePart(1, "Keep this queued")] }),
      parts: workerTranscript(),
    });
    const panel = await openWorkerChat(fixture.user);
    const input = within(panel).getByRole("combobox", { name: "Message subagent" });
    await fixture.user.type(input, "**Human Markdown**");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(await within(panel).findByText("Worker admission failed")).toBeDefined();
    expect(input).toHaveProperty("value", "**Human Markdown**");
    expect(submit).toHaveBeenCalledWith(
      { parentSessionId, handleId, text: "**Human Markdown**", renderUserMessageAsMarkdown: true },
      { signal: expect.any(AbortSignal) },
    );
    await fixture.user.click(
      within(panel).getByRole("button", { name: "Cancel queued message: Keep this queued" }),
    );
    expect(await within(panel).findByText("Queue update failed")).toBeDefined();
    expect(within(panel).getByText("Keep this queued")).toBeDefined();
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
  });

  it("switches a human worker message presentation without changing its author", async () => {
    const setUserMessageMarkdown = vi.fn<Client["subagents"]["setUserMessageMarkdown"]>(
      async () => undefined,
    );
    using fixture = renderSubagentActivity({
      client: { subagents: { setUserMessageMarkdown } },
      parts: workerTranscript(),
      activity: workerActivity({
        status: "complete",
        streaming: false,
        parts: [
          {
            id: "human-message",
            entryId: "human-entry",
            kind: "text",
            role: "user",
            text: "# Human heading",
            renderAs: "markdown",
            status: "complete",
          },
        ],
      }),
    });
    const panel = await openWorkerChat(fixture.user);
    expect(within(panel).getByRole("heading", { name: "Human heading" })).toBeDefined();
    await fixture.user.click(within(panel).getByRole("button", { name: "Render as plain text" }));
    await waitFor(() =>
      expect(setUserMessageMarkdown).toHaveBeenCalledWith(
        { parentSessionId, handleId, entryId: "human-entry", renderAsMarkdown: false },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(within(panel).getByText("# Human heading")).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Render as Markdown" })).toBeDefined();
  });

  it("opens a released worker from its persisted authority snapshot, not the parent report", async () => {
    const saved = workerActivity({
      released: true,
      status: "complete",
      streaming: false,
      parts: [
        {
          id: "original-request",
          kind: "text",
          role: "user",
          text: "Original worker request",
          status: "complete",
        },
        {
          id: "original-tool",
          kind: "tool",
          name: "read",
          input: "config.ts",
          output: "Saved tool result",
          state: "success",
        },
        {
          id: "answer",
          kind: "text",
          role: "assistant",
          text: "Original final answer",
          status: "complete",
        },
      ],
    });
    using fixture = renderSubagentActivity({ activity: saved, parts: workerTranscript() });
    const panel = await openWorkerChat(fixture.user);
    expect(await within(panel).findByText("Original worker request")).toBeDefined();
    expect(within(panel).getByText("Original final answer")).toBeDefined();
    expect(within(panel).queryByRole("combobox", { name: "Message subagent" })).toBeNull();
    fixture.publish({
      _tag: "Snapshot",
      revision: 2,
      parentSessionId,
      activities: [saved],
      backgroundActive: false,
    });
    expect(within(panel).getByText("Original worker request")).toBeDefined();
  });

  it("a deep link waits for the independent persisted-worker snapshot, even without a parent tool/report", async () => {
    using fixture = renderSubagentActivity({
      parts: [],
      catalogReady: false,
      todos: {
        ...emptyProjectTodos(),
        items: [
          {
            id: "00000000-0000-4000-8000-000000000099",
            title: "Inspect saved worker",
            description: "",
            state: "open",
            status: "",
            revision: 0,
            associations: [
              { kind: "subagent", parentSessionId, handleId, title: "Saved worker deep link" },
            ],
          },
        ],
      },
    });
    await fixture.user.click(await screen.findByRole("link", { name: "Saved worker deep link" }));
    expect(screen.queryByRole("complementary", { name: "Inspect the boundary" })).toBeNull();
    fixture.publish({
      _tag: "Snapshot",
      revision: 2,
      parentSessionId,
      activities: [workerActivity({ released: true, status: "complete", streaming: false })],
      backgroundActive: false,
    });
    const panel = await screen.findByRole("complementary", { name: "Inspect the boundary" });
    expect(await within(panel).findByText("Inspecting now")).toBeDefined();
    expect(within(panel).queryByRole("combobox", { name: "Message subagent" })).toBeNull();
  });

  it("explains a lost mapping instead of presenting the parent report as a worker conversation", async () => {
    const historical = workerActivity({
      status: "complete",
      streaming: false,
      parts: [
        {
          id: "child-answer",
          kind: "text",
          role: "assistant",
          text: "A historical boundary report.",
          status: "complete",
        },
      ],
    });
    using fixture = renderSubagentActivity({ parts: workerTranscript(historical) });
    const panel = await openWorkerChat(fixture.user);
    expect(await within(panel).findByText(/no retained handle-to-Pi mapping/)).toBeDefined();
    expect(within(panel).getByText("complete")).toBeDefined();
    expect(within(panel).queryByRole("combobox", { name: "Message subagent" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Send" })).toBeNull();
  });
});
