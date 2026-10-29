/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { renderTranscriptRendering } from "./transcript-rendering-workflow-fixture";

afterEach(cleanup);

it("keeps context runs and recovered activity separate while the reader inspects the transcript", async () => {
  const context = (id: string): UiPart => ({
    id,
    kind: "context",
    title: `Context ${id}`,
    text: `Instructions for ${id}`,
  });
  using fixture = renderTranscriptRendering([
    context("a"),
    context("b"),
    {
      id: "restored-read",
      kind: "tool",
      origin: "compacted",
      name: "read",
      input: "historical.ts",
      output: "Historical contents",
      state: "success",
    },
    { id: "current-read", kind: "tool", name: "read", input: "current.ts", state: "success" },
    { id: "reasoning", kind: "reasoning", text: "Current analysis", status: "complete" },
    context("c"),
    { id: "answer", kind: "text", role: "assistant", text: "Current answer", status: "complete" },
    context("d"),
  ]);
  const items = Array.from(fixture.container.querySelectorAll('[data-slot="transcript-item"]'));
  expect(items.map((item) => item.textContent)).toEqual([
    "Context aContext b",
    expect.stringContaining("Compacted work log"),
    expect.stringContaining("Work log"),
    "Context c",
    expect.stringContaining("Current answer"),
    "Context d",
  ]);
  const groups = fixture.container.querySelectorAll<HTMLElement>('[data-slot="context-group"]');
  expect(groups).toHaveLength(3);
  const first = groups[0];
  if (!first) throw new Error("Expected the first context run");
  expect(
    within(first)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Context a", "Context b"]);
  const compacted = screen.getByText("Compacted work log", { exact: true }).closest("details");
  const current = screen.getByText("Work log", { exact: true }).closest("details");
  if (!compacted || !current) throw new Error("Expected separate recovered and current work logs");
  expect(compacted.dataset.origin).toBe("compacted");
  expect(compacted.open).toBe(false);
  await fixture.user.click(screen.getByText("Compacted work log", { exact: true }));
  expect(compacted.open).toBe(true);
  expect(current.open).toBe(false);
  await fixture.user.click(screen.getByRole("button", { name: "Context b" }));
  expect(screen.getByText("Instructions for b")).toBeDefined();
  expect(screen.getByText("Current answer")).toBeDefined();
  expect(compacted.open).toBe(true);
});
