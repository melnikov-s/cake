/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("steers and stops a live worker, follows up after completion, and preserves released history", async () => {
    const steer = vi.fn<Client["subagents"]["steer"]>(async () => undefined);
    const prompt = vi.fn<Client["subagents"]["prompt"]>(async () => undefined);
    const abort = vi.fn<Client["subagents"]["abort"]>(async () => undefined);
    using fixture = renderSubagentActivity({
      client: { subagents: { steer, prompt, abort } },
      activity: workerActivity(),
      parts: workerTranscript(),
    });
    const panel = await openWorkerChat(fixture.user);
    expect(await within(panel).findByText("Inspecting now")).toBeDefined();
    const input = within(panel).getByRole("combobox", { name: "Message subagent" });
    expect(input.getAttribute("placeholder")).toBe("Steer this subagent…");
    await fixture.user.type(input, "  Check cancellation too  ");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(steer).toHaveBeenCalledWith(
        { parentSessionId, handleId, text: "Check cancellation too" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(prompt).not.toHaveBeenCalled();
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
      expect(prompt).toHaveBeenCalledWith(
        { parentSessionId, handleId, text: "One follow-up" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(steer).toHaveBeenCalledTimes(1);

    fixture.publish({ _tag: "Removed", revision: 3, parentSessionId, handleId });
    expect(await within(panel).findByText("complete · Resources released")).toBeDefined();
    expect(within(panel).getByText("Cancellation boundary checked.")).toBeDefined();
    expect(within(panel).queryByRole("combobox", { name: "Message subagent" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Send" })).toBeNull();
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
