/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Delta PRs widget view (real fixture source) against a stubbed cakeArtifact bridge.
const html = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/widgets/delta-pr-tracker.html"),
  "utf8",
);
const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";

const pulledAt = "2026-11-12T00:40:00.000Z";
const row = (number: number, group: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  group,
  status: "Approved by aaron.casanova · Binks clear · CI passed",
  updatedAt: pulledAt,
  ...extra,
});
const baseState = {
  schema: "delta-pr-tracker/v1",
  me: { login: "sergey.melnikov" },
  refreshedAt: pulledAt,
  warnings: [],
  history: [],
  reviewRequests: [],
  authored: [
    row(1, "ready_to_merge"),
    row(2, "blocked"),
    row(3, "merging"),
    row(4, "waiting_on_review"),
    row(5, "ready_to_merge", { mergeRequestPendingUntil: "2999-01-01T00:00:00.000Z" }),
  ],
};

type CallTool = (name: string, input: unknown) => Promise<unknown>;

function mountWidget(callTool: CallTool) {
  document.body.innerHTML = '<div id="app"></div>';
  let snapshot = { hydrated: true, version: 1, value: baseState as unknown };
  let listener = () => {};
  Object.assign(globalThis, {
    cakeArtifact: {
      read: async () => snapshot,
      getSnapshot: () => snapshot,
      subscribe: (next: () => void) => {
        listener = next;
        return () => {};
      },
      callTool,
    },
  });
  new Function(script)();
  return {
    setState(value: unknown) {
      snapshot = { hydrated: true, version: snapshot.version + 1, value };
      listener();
    },
  };
}

const numbersIn = (group: string) =>
  Array.from(document.querySelectorAll(`#sec-${group} a[data-pr]`)).map((a) =>
    Number(a.getAttribute("data-pr")),
  );
const rowOf = (number: number) =>
  document.querySelector(`a[data-pr="${number}"]`)?.closest("li") as HTMLElement;
const mergeButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button.mergebtn"));
const firstMergeButton = () => {
  const button = mergeButtons()[0];
  if (!button) throw new Error("No Merge button");
  return button;
};
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("Delta PRs view merge button", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0 as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Merge only on Ready to merge rows without a pending /merge", async () => {
    mountWidget(async () => ({}));
    await settle();
    expect(mergeButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Merge #1: post /merge",
    ]);
    expect(numbersIn("ready_to_merge")).toEqual([1, 5]);
  });

  it("moves the row to Merging at once, posts once, and lets the next refresh decide", async () => {
    let finish: (value: unknown) => void = () => {};
    const callTool = vi.fn<CallTool>(() => new Promise((done) => (finish = done)));
    const widget = mountWidget(callTool);
    await settle();

    const button = firstMergeButton();
    button.click();
    button.click();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("merge_pr", { number: 1 });
    expect(numbersIn("merging")).toEqual([1, 3]);
    expect(rowOf(1).textContent).toContain("requested");
    expect(rowOf(1).textContent).toContain("Merging: posting /merge…");
    expect(mergeButtons()).toEqual([]);

    finish({ posted: true, number: 1, at: "2026-11-12T00:41:00.000Z" });
    await settle();
    expect(numbersIn("merging")).toEqual([1, 3]);
    expect(rowOf(1).textContent).toContain("/merge posted");
    expect(rowOf(1).textContent).toContain("confirmed on next refresh");

    // The backend's saved override keeps it there across views...
    widget.setState({
      ...baseState,
      mergeOverrides: { "1": { at: "2026-11-12T00:41:00.000Z", pull: 3 } },
    });
    expect(numbersIn("merging")).toEqual([1, 3]);

    // ...until a refresh clears it and live state decides: Merge Garden confirmed it.
    widget.setState({
      ...baseState,
      refreshedAt: "2026-11-12T00:55:00.000Z",
      mergeOverrides: {},
      authored: baseState.authored.map((r) =>
        r.number === 1 ? { ...r, group: "merging", status: "Merging: waiting for CI" } : r,
      ),
    });
    expect(numbersIn("merging")).toEqual([1, 3]);
    expect(rowOf(1).querySelector(".pill.req")).toBeNull();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("undoes the move and shows the error on the row when the post fails", async () => {
    let fail: (error: Error) => void = () => {};
    mountWidget(() => new Promise((_, reject) => (fail = reject)));
    await settle();

    firstMergeButton().click();
    expect(numbersIn("merging")).toEqual([1, 3]);
    fail(new Error("Could not post /merge on #1: exit 1 — Error: 403 Forbidden"));
    await settle();

    expect(numbersIn("ready_to_merge")).toEqual([1, 5]);
    expect(rowOf(1).querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't post /merge: Could not post /merge on #1: exit 1 — Error: 403 Forbidden",
    );
    expect(mergeButtons()).toHaveLength(1);
  });
});
