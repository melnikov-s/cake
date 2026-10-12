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
