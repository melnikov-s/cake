/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import {
  addedFile,
  readFile,
  removedFile,
  renderWorkLog,
} from "./work-log-presentation-workflow-fixture";

function workLog() {
  const summary = screen.getByText("Work log", { exact: true }).closest("summary");
  const group = summary?.closest("details");
  if (!summary || !group) throw new Error("Missing work log disclosure");
  return { summary, group };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Work-log presentation workflow", () => {
  it.each(["widgets.present", "artifacts.preview", "artifacts.replace", "artifacts.restore"])(
    "labels %s retained pixels as initial state outside the collapsed log",
    (command) => {
      using fixture = renderWorkLog([
        {
          id: "initial-preview",
          kind: "tool",
          name: "cake",
          input: JSON.stringify({ command }),
          state: "success",
          outputContent: [{ type: "image", mimeType: "image/png", data: "AA==" }],
        },
      ]);
      expect(workLog().group.open).toBe(false);
      expect(screen.getByText("Initial state—not current interactive view")).toBeDefined();
      expect(
        screen.getByRole("img", { name: "Initial state—not current interactive view" }),
      ).toBeDefined();
      expect(fixture).toBeDefined();
    },
  );

  it("reveals native image results as a tool settles and keeps them visible across log disclosure and replay", async () => {
    const tool: Extract<UiPart, { kind: "tool" }> = {
      id: "generate-image",
      kind: "tool",
      name: "codemode",
      input: "image(result.output[0]);",
      state: "running",
    };
    using fixture = renderWorkLog([tool], { streaming: true });
    expect(workLog().group.open).toBe(false);
    expect(screen.queryByRole("img")).toBeNull();
    const completed: Extract<UiPart, { kind: "tool" }> = {
      ...tool,
      state: "success",
      output: "Script completed",
      outputContent: [
        { type: "text", text: "Script completed" },
        { type: "image", mimeType: "image/png", data: "AA==" },
        { type: "image", mimeType: "image/jpeg", data: "AQ==" },
      ],
    };
    fixture.publish([completed]);
    const previews = screen.getAllByRole("img");
    expect(previews.map((preview) => preview.getAttribute("src"))).toEqual([
      "data:image/png;base64,AA==",
      "data:image/jpeg;base64,AQ==",
    ]);
    for (const preview of previews) {
      expect(preview.closest("[data-part-id]")?.getAttribute("data-part-id")).toBe(tool.id);
      expect(preview.closest("[data-slot=activity-group]")).toBeNull();
    }
    const { summary, group } = workLog();
    expect(group.open).toBe(false);
    expect(screen.queryByText("Script completed")).toBeNull();
    await fixture.user.click(summary);
    await fixture.user.click(screen.getByRole("button", { name: /^codemode/ }));
    expect(await screen.findByText("Script completed")).toBeDefined();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    await fixture.user.click(summary);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    fixture.publish([completed]);
    expect(workLog().group.open).toBe(false);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("discloses compacted history separately from current work without treating that history as running", async () => {
    const historical = { ...readFile("historical"), origin: "compacted" as const };
    using fixture = renderWorkLog([historical, readFile("current", "running")], {
      streaming: true,
    });
    const compacted = screen.getByText("Compacted work log", { exact: true }).closest("details");
    if (!compacted) throw new Error("Missing compacted work log");
    expect(compacted.open).toBe(false);
    expect(compacted.dataset.origin).toBe("compacted");
    expect(compacted.className).toContain("opacity-75");
    const compactedSummary = within(compacted).getByText("Compacted work log");
    await fixture.user.click(compactedSummary);
    const historicalTool = within(compacted).getByRole("button", { name: /^read historical/ });
    await fixture.user.click(historicalTool);
    expect(await within(compacted).findByText("Contents of historical")).toBeDefined();
    expect(workLog().group.open).toBe(false);
    fixture.publish([historical, readFile("current")]);
    expect(compacted.open).toBe(true);
    expect(historicalTool.getAttribute("aria-expanded")).toBe("true");
    expect(workLog().summary.textContent).not.toContain("read current");
  });

  it("keeps the last tool active between streamed parts, then settles the group even when an individual call failed", async () => {
    const tool = readFile("current");
    using fixture = renderWorkLog([tool], { streaming: true });
    const { summary, group } = workLog();
    expect(summary.textContent).toContain("1 tool call · read current.ts");
    expect(summary.querySelector('span[aria-hidden="true"]')?.className).toContain("animate-pulse");
    fixture.publish(
      [
        { ...tool, state: "error", output: "Permission denied" },
        {
          id: "answer",
          kind: "text",
          role: "assistant",
          text: "Could not read it",
          status: "streaming",
        },
      ],
      true,
    );
    expect(summary.textContent).toContain("1 tool call");
    expect(summary.textContent).not.toContain("read current.ts");
    await fixture.user.click(summary);
    const failed = within(group).getByRole("button", { name: /^read current/ });
    await fixture.user.click(failed);
    expect(await within(group).findByText("Permission denied")).toBeDefined();
    fixture.publish([
      { ...tool, state: "error", output: "Permission denied" },
      {
        id: "answer",
        kind: "text",
        role: "assistant",
        text: "Could not read it",
        status: "complete",
      },
    ]);
    expect(group.open).toBe(true);
    expect(failed.getAttribute("aria-expanded")).toBe("true");
    expect(summary.querySelector('span[aria-hidden="true"]')?.className).toContain("bg-success");
  });

  it("retains the real streaming diff and expanded activity while the elapsed clock advances", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    using fixture = renderWorkLog([addedFile("running")], { streaming: true });
    await fixture.user.click(workLog().summary);
    const diff = screen.getByRole("region", { name: "File changes to src/added.ts" });
    const steps = screen.getByRole("button", { name: "1 tool call · 0.0s Activity View steps" });
    await fixture.user.click(steps);
    const tool = screen.getByRole("button", { name: /^write/ });
    await fixture.user.click(tool);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("region", { name: "File changes to src/added.ts" })).toBe(diff);
    expect(diff.textContent).toContain("one");
    expect(diff.textContent).toContain("three");
    expect(screen.getByRole("button", { name: "1 tool call · 0.5s Activity Hide steps" })).toBe(
      steps,
    );
    expect(tool.getAttribute("aria-expanded")).toBe("true");
  });

  it("summarizes added and removed files without counting reads or inventing elapsed history", async () => {
    using fixture = renderWorkLog([addedFile(), readFile("read-only"), removedFile()]);
    const { summary, group } = workLog();
    expect(summary.textContent).toContain("2 edits · +3 −4");
    expect(group.open).toBe(false);
    await fixture.user.click(summary);
    const added = screen.getByRole("region", { name: "File changes to src/added.ts" });
    const removed = screen.getByRole("region", { name: "File changes to src/removed.ts" });
    expect(added.textContent).toContain("one");
    expect(added.textContent).toContain("three");
    expect(removed.textContent).toContain("oldOne");
    expect(removed.textContent).toContain("oldFour");
    const steps = within(group).getByRole("button", { name: "3 tool calls Activity View steps" });
    await fixture.user.click(steps);
    expect(within(group).getByRole("button", { name: /^read/ })).toBeDefined();
    expect(within(group).queryByLabelText("elapsed time")).toBeNull();
  });

  it("counts live elapsed time across successive tools and freezes both group and item durations on completion", async () => {
    // Keep UI scheduling real; only the presentation clock is controlled.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    using fixture = renderWorkLog([addedFile("running")], { streaming: true });
    const { summary, group } = workLog();
    await fixture.user.click(summary);
    expect(
      within(group).getByRole("button", { name: "1 tool call · 0.0s Activity View steps" }),
    ).toBeDefined();
    act(() => vi.advanceTimersByTime(1_000));
    expect(
      within(group).getByRole("button", { name: "1 tool call · 1.0s Activity View steps" }),
    ).toBeDefined();

    fixture.publish([addedFile(), removedFile("running")], true);
    act(() => vi.advanceTimersByTime(1_500));
    const steps = within(group).getByRole("button", {
      name: "2 tool calls · 2.5s Activity View steps",
    });
    await fixture.user.click(steps);
    expect(
      within(group)
        .getAllByLabelText("elapsed time")
        .map((chip) => chip.textContent),
    ).toEqual(["1.0s", "1.5s"]);

    fixture.publish([addedFile(), removedFile()]);
    expect(group.open).toBe(true);
    act(() => vi.advanceTimersByTime(5_000));
    expect(
      within(group).getByRole("button", { name: "2 tool calls · 2.5s Activity Hide steps" }),
    ).toBeDefined();
    expect(
      within(group)
        .getAllByLabelText("elapsed time")
        .map((chip) => chip.textContent),
    ).toEqual(["1.0s", "1.5s"]);
  });

  it("retains the open surviving group when a tool is removed and resets disclosure after the whole group disappears", async () => {
    using fixture = renderWorkLog([readFile("first"), readFile("second")]);
    const { summary, group } = workLog();
    await fixture.user.click(summary);
    await fixture.user.click(screen.getByRole("button", { name: /^read first/ }));
    expect(screen.getByRole("button", { name: /^read first/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    fixture.publish([readFile("second")]);
    expect(group.open).toBe(true);
    expect(screen.getByRole("button", { name: /^read second/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^read first/ })).toBeNull();
    fixture.publish([]);
    fixture.publish([readFile("first")]);
    const newGroup = workLog();
    expect(newGroup.group.open).toBe(false);
    await fixture.user.click(newGroup.summary);
    expect(screen.getByRole("button", { name: /^read first/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("keeps each Chat's elapsed history independent when another Chat is torn down", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    {
      using first = renderWorkLog([readFile("shared-tool", "running")], { streaming: true });
      const firstChat = within(first.container);
      await first.user.click(firstChat.getByText("Work log", { exact: true }));
      act(() => vi.advanceTimersByTime(500));
      {
        using second = renderWorkLog([readFile("shared-tool", "running")], { streaming: true });
        const secondChat = within(second.container);
        await second.user.click(secondChat.getByText("Work log", { exact: true }));
        act(() => vi.advanceTimersByTime(1_000));
        expect(firstChat.getByLabelText("elapsed time").textContent).toBe("1.5s");
        expect(secondChat.getByLabelText("elapsed time").textContent).toBe("1.0s");
      }
      act(() => vi.advanceTimersByTime(500));
      expect(firstChat.getByLabelText("elapsed time").textContent).toBe("2.0s");
    }
  });

  it("prunes a removed tool's elapsed history and disclosure while retaining the surviving tool", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    using fixture = renderWorkLog([readFile("first", "running"), readFile("second", "running")], {
      streaming: true,
    });
    await fixture.user.click(workLog().summary);
    await fixture.user.click(screen.getByRole("button", { name: /^read first/ }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getAllByLabelText("elapsed time").map((chip) => chip.textContent)).toEqual([
      "1.0s",
      "1.0s",
    ]);

    fixture.publish([readFile("second")]);
    expect(screen.queryByRole("button", { name: /^read first/ })).toBeNull();
    fixture.publish([readFile("first", "running"), readFile("second")], true);
    expect(screen.getByRole("button", { name: /^read first/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.getAllByLabelText("elapsed time").map((chip) => chip.textContent)).toEqual([
      "0.0s",
      "1.0s",
    ]);
  });

  it("keeps elapsed history while assistant tokens stream and freezes it when authority completes the tool", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    using fixture = renderWorkLog([readFile("first", "running")], { streaming: true });
    await fixture.user.click(workLog().summary);
    act(() => vi.advanceTimersByTime(500));
    for (const text of ["Inspecting", "Inspecting the results"]) {
      fixture.publish(
        [
          readFile("first", "running"),
          { id: "assistant", kind: "text", role: "assistant", text, status: "streaming" },
        ],
        true,
      );
      act(() => vi.advanceTimersByTime(500));
    }
    expect(screen.getByLabelText("elapsed time").textContent).toBe("1.5s");
    expect(screen.getByText("Inspecting the results")).toBeDefined();
    fixture.publish([readFile("first")]);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByLabelText("elapsed time").textContent).toBe("1.5s");
  });

  it("preserves the user's open group as live reasoning is replaced by its settled transcript identity", async () => {
    using fixture = renderWorkLog(
      [{ id: "live-reasoning", kind: "reasoning", text: "Inspecting", status: "streaming" }],
      { streaming: true },
    );
    await fixture.user.click(workLog().summary);
    expect(screen.getByRole("button", { name: "Thinking…" })).toBeDefined();
    fixture.publish([
      {
        id: "entry-assistant-reasoning-0",
        kind: "reasoning",
        text: "Inspected",
        status: "complete",
      },
    ]);
    expect(workLog().group.open).toBe(true);
    const reasoning = screen.getByRole("button", { name: "Reasoning" });
    await fixture.user.click(reasoning);
    expect(await screen.findByText("Inspected")).toBeDefined();
  });
});
