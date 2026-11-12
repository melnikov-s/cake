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

type Context = { project: { path: string; name: string } | null } | null;

function mountWidget(callTool: CallTool, value: unknown = baseState, context: Context = null) {
  document.body.innerHTML = '<div id="app"></div>';
  let snapshot = { hydrated: true, version: 1, value };
  let listener = () => {};
  let contextListener: (next: Context) => void = () => {};
  Object.assign(globalThis, {
    cakeArtifact: {
      read: async () => snapshot,
      getSnapshot: () => snapshot,
      subscribe: (next: () => void) => {
        listener = next;
        return () => {};
      },
      getContext: () => context,
      subscribeContext: (next: (value: Context) => void) => {
        contextListener = next;
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
    setContext(next: Context) {
      contextListener(next);
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

const SELF_HEALING = { path: "/w/src/system/self-healing", name: "self-healing" };
const ADMIN_WEB = { path: "/w/src/areas/clients/admin-web", name: "admin-web" };
const fixRow = (
  number: number,
  group: string,
  projects: { path: string; name: string }[] | null,
  extra: Record<string, unknown> = {},
) =>
  row(number, group, {
    projects,
    fixKey: ["blocked", "binks_comments", "ci_failing"].includes(group) ? `key-${number}` : null,
    ...extra,
  });
const fixState = {
  ...baseState,
  authored: [
    fixRow(11, "blocked", [SELF_HEALING]),
    fixRow(12, "blocked", [SELF_HEALING, ADMIN_WEB]),
    fixRow(13, "binks_comments", [ADMIN_WEB]),
    fixRow(14, "ci_failing", [SELF_HEALING]),
    fixRow(15, "ci_failing", []),
    fixRow(16, "ready_to_merge", [SELF_HEALING]),
    fixRow(17, "waiting_on_review", [SELF_HEALING]),
    fixRow(18, "draft", [SELF_HEALING]),
    fixRow(19, "merging", [SELF_HEALING]),
  ],
  reviewRequests: [
    row(30, "waiting_on_my_review", { projects: [ADMIN_WEB] }),
    row(31, "waiting_on_my_review", { projects: [SELF_HEALING] }),
  ],
};
const fixButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button.fixbtn")).map((b) =>
    b.getAttribute("aria-label"),
  );
const fixAll = (group: string) =>
  document.querySelector<HTMLButtonElement>(`#sec-${group} button.fixall`);
const fixButtonOf = (number: number) =>
  rowOf(number).querySelector<HTMLButtonElement>("button.fixbtn");
const requestedNumbers = () =>
  Array.from(document.querySelectorAll(".pill.fixreq")).map((pill) =>
    Number(pill.closest("li")?.querySelector("a[data-pr]")?.getAttribute("data-pr")),
  );
const sent = (numbers: number[], at = "2026-11-12T00:41:00.000Z") => ({
  requested: numbers.map((number) => ({
    number,
    project: SELF_HEALING,
    chatId: "project-chat:self-healing",
    at,
    until: "2999-01-01T00:00:00.000Z",
  })),
  skipped: [],
  failed: [],
});

describe("Delta PRs view Fix and project scope", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0 as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts Fix on Blocked, Binks comments and CI failing rows with a project, and Fix all in their headers", async () => {
    mountWidget(async () => ({}), fixState);
    await settle();
    expect(fixButtons()).toEqual([
      "Fix #11: ask the self-healing chat",
      "Fix #12: ask the self-healing chat",
      "Fix #13: ask the admin-web chat",
      "Fix #14: ask the self-healing chat",
    ]);
    expect(fixAll("blocked")?.getAttribute("aria-label")).toBe("Fix all in Blocked: 2 PRs");
    expect(fixAll("binks_comments")?.getAttribute("aria-label")).toBe(
      "Fix all in Binks comments: 1 PR",
    );
    // #15 matches no project: no Fix, and Fix all does not count it.
    expect(fixAll("ci_failing")?.getAttribute("aria-label")).toBe("Fix all in CI failing: 1 PR");
    for (const group of ["ready_to_merge", "waiting_on_review", "draft", "merging"])
      expect(fixAll(group)).toBeNull();
  });

  it("scopes to the viewed project, can show all, and re-scopes when the chat changes", async () => {
    const widget = mountWidget(async () => ({}), fixState, { project: SELF_HEALING });
    await settle();
    expect(numbersIn("blocked")).toEqual([11, 12]);
    expect(numbersIn("binks_comments")).toEqual([]);
    expect(numbersIn("ci_failing")).toEqual([14]);
    expect(numbersIn("waiting_on_my_review")).toEqual([31]);
    expect(document.querySelector(".scope")?.textContent).toBe(
      "self-healing · 8 of 11 PRsShow all projects",
    );

    (document.querySelector(".scope button") as HTMLButtonElement).click();
    expect(numbersIn("ci_failing")).toEqual([14, 15]);
    expect(document.querySelector(".scope")?.textContent).toBe(
      "All projects · 11 PRsOnly self-healing",
    );

    widget.setContext({ project: ADMIN_WEB });
    expect(numbersIn("blocked")).toEqual([12]);
    expect(numbersIn("binks_comments")).toEqual([13]);
    expect(fixButtons()).toEqual([
      "Fix #12: ask the admin-web chat",
      "Fix #13: ask the admin-web chat",
    ]);

    // No project in view (Cake Chat, Home): everything, without a scope line.
    widget.setContext({ project: null });
    expect(numbersIn("ci_failing")).toEqual([14, 15]);
    expect(document.querySelector(".scope")).toBeNull();
  });

  it("does not hide anything before a refresh has mapped PRs to projects", async () => {
    mountWidget(async () => ({}), baseState, { project: SELF_HEALING });
    await settle();
    expect(numbersIn("ready_to_merge")).toEqual([1, 5]);
    expect(document.querySelector(".scope")).toBeNull();
  });

  it("Fix all covers only the rows shown, with the viewed project", async () => {
    const callTool = vi.fn<CallTool>(async () => sent([11, 12]));
    mountWidget(callTool, fixState, { project: SELF_HEALING });
    await settle();
    fixAll("blocked")?.click();
    expect(callTool).toHaveBeenCalledWith("request_fix", {
      numbers: [11, 12],
      source: "fix_all",
      projectPath: SELF_HEALING.path,
    });
    await settle();
    expect(requestedNumbers()).toEqual([11, 12]);
    expect(fixAll("blocked")).toBeNull();
  });

  it("marks a row requested at once, sends once on a double click, and Fix all skips it", async () => {
    const replies: ((value: unknown) => void)[] = [];
    const callTool = vi.fn<CallTool>(() => new Promise((done) => replies.push(done)));
    const widget = mountWidget(callTool, fixState);
    await settle();

    const button = fixButtonOf(11);
    button?.click();
    button?.click();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("request_fix", { numbers: [11], source: "row" });
    expect(fixButtonOf(11)?.disabled).toBe(true);
    expect(rowOf(11).textContent).toContain("Fix: asking the self-healing chat…");
    // Fix all while #11 is in flight covers only #12.
    fixAll("blocked")?.click();
    expect(callTool).toHaveBeenLastCalledWith("request_fix", { numbers: [12], source: "fix_all" });

    replies[0]?.(sent([11]));
    replies[1]?.(sent([12]));
    await settle();
    expect(requestedNumbers()).toEqual([11, 12]);
    expect(fixButtonOf(11)).toBeNull();
    expect(rowOf(11).textContent).toContain("Fix: asked the self-healing chat");

    // The saved request keeps it across views; a changed PR state (new fixKey) offers Fix again.
    const saved = {
      "11": {
        at: "2026-11-12T00:41:00.000Z",
        until: "2999-01-01T00:00:00.000Z",
        key: "key-11",
        project: SELF_HEALING,
      },
    };
    widget.setState({ ...fixState, fixRequests: saved });
    expect(requestedNumbers()).toContain(11);
    widget.setState({
      ...fixState,
      fixRequests: saved,
      authored: fixState.authored.map((r) => (r.number === 11 ? { ...r, fixKey: "pushed" } : r)),
    });
    expect(fixButtonOf(11)?.getAttribute("aria-label")).toBe("Fix #11: ask the self-healing chat");
  });

  it("shows the error on the row and restores Fix when the send fails", async () => {
    let fail: (error: Error) => void = () => {};
    mountWidget(() => new Promise((_, reject) => (fail = reject)), fixState);
    await settle();
    fixButtonOf(13)?.click();
    expect(fixButtonOf(13)?.disabled).toBe(true);
    fail(new Error("Could not message the admin-web chat: Chat is unavailable"));
    await settle();
    expect(rowOf(13).querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't send Fix: Could not message the admin-web chat: Chat is unavailable",
    );
    expect(fixButtonOf(13)?.disabled).toBe(false);
    expect(requestedNumbers()).toEqual([]);
  });

  it("attributes a partial Fix all failure to the rows that failed", async () => {
    mountWidget(
      async () => ({
        requested: sent([11]).requested,
        skipped: [],
        failed: [{ number: 12, error: "Could not message the self-healing chat: busy" }],
      }),
      fixState,
    );
    await settle();
    fixAll("blocked")?.click();
    await settle();
    expect(requestedNumbers()).toEqual([11]);
    expect(rowOf(12).querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't send Fix: Could not message the self-healing chat: busy",
    );
    expect(fixButtonOf(12)).not.toBeNull();
  });
});
