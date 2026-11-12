import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The Delta PRs widget's published backend runtime (async factory body with lexical cake/data).
// These tests drive its real refresh path with canned, already-jq-slimmed Delta responses.
const runtimeSource = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/widgets/delta-pr-tracker.runtime.js"),
  "utf8",
);

const ME = "sergey.melnikov@shopify.com";
const BINKS = {
  login: "binks-production-unrestricted@shopify-applications.iam.gserviceaccount.com",
  type: "User",
  brand: "Binks",
};
const RIVER_USER = {
  login: "aquifer-sandbox-runtime@shopify-aquifer.iam.gserviceaccount.com",
  service_brand: { display_name: "River" },
};
const human = (login: string) => ({ login: `${login}@shopify.com`, type: "User", brand: null });
const BINKS_CTX = "binks-production-unrestricted@shopify-applications.iam.gserviceaccount.com";
const CI_CTX = "test-oversight-servic-kkelzk54@shopify-applications.iam.gserviceaccount.com";

type Reviewer = { login: string; type: string; brand: string | null };
type Review = { state: string; at: string; by: Reviewer; dismissed?: boolean };
type Stance = { author: string; counts: boolean; current: boolean; state: string };
type Pr = {
  number: number;
  title?: string;
  draft?: boolean;
  user?: { login: string; service_brand?: { display_name: string } | null };
  head?: string;
  reviews?: Review[];
  stances?: Stance[];
  blockers?: { code: string; context?: string }[];
  // Successive merge-readiness reads return these blockers (the last one repeats).
  blockersByRead?: { code: string; context?: string }[][];
  readinessMergeable?: boolean | null;
  pull?: { mergeable: boolean | null; mergeable_state: string };
  binks?: "success" | "failure" | "pending" | "missing";
  // Merge Garden comments and /merge commands (already slimmed like the runtime's jq filter).
  comments?: { at: string; brand?: string | null; login?: string; body: string }[];
  // pending: "CI not yet run."; running: Required CI is running.
  ci?: "success" | "pending" | "running";
  // Unresolved review threads (merge readiness).
  threads?: number;
  // Delta zone labels ("//system/self-healing") and changed paths (undefined: the files read 404s).
  labels?: string[];
  files?: string[];
  failingCheck?: string;
};

function searchItem(pr: Pr) {
  return {
    number: pr.number,
    title: pr.title ?? `PR ${pr.number}`,
    draft: !!pr.draft,
    updated_at: "2026-11-11T23:40:00Z",
    created_at: "2026-11-01T00:00:00Z",
    user: pr.user ?? { login: ME, service_brand: null },
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: pr.labels ?? [],
  };
}

function checksFor(pr: Pr) {
  const statuses: unknown[] = [];
  if (pr.failingCheck)
    statuses.push({
      context: pr.failingCheck,
      state: "failure",
      description: "Failed",
      creator: { login: CI_CTX, service_brand: null },
    });
  if (pr.binks && pr.binks !== "missing")
    statuses.push({
      context: "PR Review Bot Comments Addressed",
      state: pr.binks,
      description:
        pr.binks === "failure"
          ? "❌ 1 open Binks finding"
          : pr.binks === "pending"
            ? "Binks is reviewing"
            : "No unresolved findings",
      creator: { login: BINKS.login, service_brand: { display_name: "Binks" } },
    });
  if (pr.ci)
    statuses.push({
      context: "Required CI",
      state: pr.ci === "running" ? "pending" : pr.ci,
      description:
        pr.ci === "success" ? "Passed" : pr.ci === "running" ? "Running" : "CI not yet run.",
      creator: { login: CI_CTX, service_brand: null },
    });
  return { check_runs: [], statuses: { state: "pending", statuses } };
}

function readinessFor(pr: Pr, read: number) {
  const reviews = pr.reviews ?? [];
  const stances =
    pr.stances ??
    reviews.map((r) => ({
      author: r.by.login,
      commit: pr.head ?? "head",
      counts: !r.by.brand,
      current: true,
      state: r.state.toLowerCase(),
    }));
  return {
    head: pr.head ?? "head",
    mergeable: pr.readinessMergeable ?? null,
    merge_state_status: "unknown",
    blockers: pr.blockersByRead
      ? pr.blockersByRead[Math.min(read, pr.blockersByRead.length - 1)]
      : (pr.blockers ?? []),
    reviews: {
      approved: stances.filter((s) => s.state === "approved" && s.counts).length,
      changes_requested: 0,
      unresolved_threads: pr.threads ?? 0,
      stances,
    },
    status_check_rollup: { state: "pending", contexts: [] },
  };
}

function reviewsFor(pr: Pr) {
  return (pr.reviews ?? []).map((r) => ({
    state: r.state,
    submitted_at: r.at,
    commit_id: pr.head ?? "head",
    dismissed: !!r.dismissed,
    user: r.by,
  }));
}

// Stub for `dt pr comment`: records the command and never reaches Delta.
type PostStub = {
  commands: string[];
  result?: () => Promise<{ exitCode: number; stderr: string }>;
};

// Registered Cake projects (projects.list) and a chat.prompt stub that records every message
// instead of reaching a real Project Chat.
const WORLD = "/Users/user/world/trees";
const PROJECTS = [
  { path: `${WORLD}/self-healing/src/system/self-healing`, name: "self-healing" },
  { path: `${WORLD}/system-agents/src/system/agents`, name: "system-agents" },
  { path: `${WORLD}/root/src/areas/clients/admin-web`, name: "admin-web" },
  { path: "/Users/user/cake", name: "cake" },
].map((p) => ({ ...p, projectChatId: `project-chat:${p.name}` }));
type ChatStub = {
  prompts: { sessionId: string; text: string }[];
  result?: (input: { sessionId: string; text: string }) => Promise<unknown>;
  projects?: () => Promise<unknown>;
  // PR numbers whose changed files were read.
  filesRead?: number[];
  // Every shell command run.
  shell?: string[];
};

function fakeDelta(
  scenario: { authored: Pr[]; assigned?: Pr[]; requested?: Pr[] },
  post?: PostStub,
  chat?: ChatStub,
) {
  const all = new Map<number, Pr>();
  for (const pr of [
    ...scenario.authored,
    ...(scenario.assigned ?? []),
    ...(scenario.requested ?? []),
  ])
    all.set(pr.number, pr);
  const readinessReads = new Map<number, number>();
  const search = (prs: Pr[] = []) => ({ total_count: prs.length, items: prs.map(searchItem) });
  const respond = (command: string): unknown => {
    if (command.includes("/api/v3/user")) return { login: "sergey.melnikov", email: ME };
    if (command.includes("author:@me")) return search(scenario.authored);
    if (command.includes("assignee:@me")) return search(scenario.assigned);
    if (command.includes("review-requested:@me")) return search(scenario.requested);
    const number = Number(/(?:pr checks |pulls\/|issues\/)(\d+)/.exec(command)?.[1]);
    const pr = all.get(number);
    if (!pr) throw new Error(`Unexpected command: ${command}`);
    if (command.includes("pr checks")) return checksFor(pr);
    if (command.includes("/merge-readiness")) {
      const read = readinessReads.get(number) ?? 0;
      readinessReads.set(number, read + 1);
      return readinessFor(pr, read);
    }
    if (command.includes("/reviews")) return reviewsFor(pr);
    if (command.includes("/comments"))
      return (pr.comments ?? []).map((c) => ({ brand: null, login: ME, ...c }));
    return pr.pull ?? { mergeable: null, mergeable_state: "unknown" };
  };
  return async (name: string, input: { command: string }) => {
    if (name === "projects.list") {
      if (chat?.projects) return chat.projects();
      return { ok: true, total: PROJECTS.length, offset: 0, nextOffset: null, projects: PROJECTS };
    }
    if (name === "chat.prompt") {
      const prompt = input as unknown as { sessionId: string; text: string };
      if (!chat) throw new Error(`Unexpected chat.prompt to ${prompt.sessionId}`);
      chat.prompts.push(prompt);
      return chat.result
        ? chat.result(prompt)
        : { ok: true, sessionId: prompt.sessionId, turnId: `turn-${chat.prompts.length}` };
    }
    expect(name).toBe("shell.run");
    chat?.shell?.push(input.command);
    if (input.command.includes("/files?")) {
      const pr = all.get(Number(/pulls\/(\d+)\/files/.exec(input.command)?.[1]));
      if (pr) chat?.filesRead?.push(pr.number);
      return pr?.files
        ? { exitCode: 0, stdout: JSON.stringify(pr.files), stderr: "", timedOut: false }
        : { exitCode: 1, stdout: "", stderr: "Error: 404: recorded head is not available" };
    }
    if (input.command.includes("pr comment")) {
      if (!post) throw new Error(`Unexpected post: ${input.command}`);
      post.commands.push(input.command);
      const result = post.result ? await post.result() : { exitCode: 0, stderr: "" };
      return { ...result, stdout: "", timedOut: false, stdoutTruncated: false };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(respond(input.command)),
      stderr: "",
      timedOut: false,
      stdoutTruncated: false,
    };
  };
}

type Row = {
  number: number;
  group: string;
  lanes: string[];
  status: string;
  review: string;
  approvedBy: string[];
  blockedBy: string[];
  blockReasons: string[];
  pending: string[];
  ownership: string;
  authorBrand: string | null;
  ignoredApprovals: { by: string; reason: string }[];
  mergeRequestPendingUntil: string | null;
  projects: { path: string; name: string }[] | null;
  projectSource: string | null;
  fixReason: string | null;
  fixKey: string | null;
};
type State = {
  authored: Row[];
  reviewRequests: { number: number; projects: { name: string }[] | null }[];
  mergeOverrides: Record<string, { at: string }>;
  fixRequests: Record<string, { at: string; until: string; project: { name: string } }>;
  warnings: string[];
};

async function loadRuntime(cake: ReturnType<typeof fakeDelta>) {
  let saved: unknown = null;
  const data = {
    read: async () => saved,
    write: async (value: unknown) => {
      saved = value;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const bridge = (name: string, input: { command: string }) => cake(name, input);
  const runtime = await new AsyncFunction("cake", "data", runtimeSource)(bridge, data);
  return {
    refresh: async () => {
      await runtime.tools.refresh({ source: "agent" });
      return saved as State;
    },
    swap(next: ReturnType<typeof fakeDelta>) {
      cake = next;
    },
    mergePr: (number: number) => runtime.tools.merge_pr({ number }),
    requestFix: (input: { numbers: number[]; projectPath?: string; source?: string }) =>
      runtime.tools.request_fix(input),
    listPrs: (group: string) => runtime.tools.list_prs({ group }),
    listAll: () => runtime.tools.list_prs({}),
    summary: () => runtime.tools.summary({}),
    state: () => saved as State,
  };
}

async function refresh(scenario: Parameters<typeof fakeDelta>[0]) {
  return (await loadRuntime(fakeDelta(scenario))).refresh();
}

const row = (state: State, number: number) => {
  const found = state.authored.find((r) => r.number === number);
  if (!found) throw new Error(`#${number} is not one of my PRs`);
  return found;
};

describe("Delta PRs runtime grouping", () => {
  it("puts a human-approved PR with missing required checks in CI pending, not Blocked (#2189563)", async () => {
    const state = await refresh({
      authored: [
        {
          number: 2189563,
          reviews: [{ state: "APPROVED", at: "2026-11-11T23:15:12Z", by: human("aaron.casanova") }],
          blockers: [
            { code: "required_check_missing", context: `${BINKS_CTX}:restricted-merges` },
            { code: "required_check_missing", context: `${BINKS_CTX}:reviews` },
            {
              code: "required_status_missing",
              context: `${BINKS_CTX}:PR Review Bot Comments Addressed`,
            },
            { code: "required_status_missing", context: `${CI_CTX}:Required CI` },
          ],
        },
      ],
    });
    const pr = row(state, 2189563);
    expect(pr.lanes).toEqual(["ci_pending"]);
    expect(pr.approvedBy).toEqual(["aaron.casanova"]);
    expect(pr.blockedBy).toEqual([]);
    expect(pr.pending).toEqual([
      "restricted-merges check missing",
      "reviews check missing",
      "Binks comments status missing",
    ]);
    expect(pr.status).toContain(
      "Pending: restricted-merges check missing, reviews check missing, Binks comments status missing",
    );
    expect(pr.status).toContain("Approved by aaron.casanova");
    expect(pr.status).not.toContain("Needs approval");
  });

  it("puts a PR with two human approvals on an older commit and a missing reviews check in CI pending (#2306172)", async () => {
    const state = await refresh({
      authored: [
        {
          number: 2306172,
          binks: "success",
          ci: "pending",
          reviews: [
            { state: "APPROVED", at: "2026-10-23T14:06:42Z", by: human("carlos.corvaia") },
            { state: "APPROVED", at: "2026-10-23T14:08:37Z", by: human("ryan.wilsonperkin") },
            { state: "CHANGES_REQUESTED", at: "2026-10-23T14:19:50Z", by: BINKS },
            { state: "APPROVED", at: "2026-10-23T20:51:05Z", by: BINKS },
          ],
          stances: [
            { author: BINKS.login, counts: false, current: true, state: "approved" },
            {
              author: human("carlos.corvaia").login,
              counts: true,
              current: false,
              state: "approved",
            },
            {
              author: human("ryan.wilsonperkin").login,
              counts: true,
              current: false,
              state: "approved",
            },
          ],
          blockers: [
            { code: "required_check_missing", context: `${BINKS_CTX}:restricted-merges` },
            { code: "required_check_missing", context: `${BINKS_CTX}:reviews` },
            { code: "required_status_pending", context: `${CI_CTX}:Required CI` },
          ],
        },
      ],
    });
    const pr = row(state, 2306172);
    expect(pr.lanes).toEqual(["ci_pending"]);
    expect(pr.approvedBy).toEqual(["carlos.corvaia", "ryan.wilsonperkin"]);
    expect(pr.blockedBy).toEqual([]);
    expect(pr.pending).toEqual(["restricted-merges check missing", "reviews check missing"]);
    expect(pr.ignoredApprovals).toEqual([{ by: "Binks", reason: "bot" }]);
  });

  it("names a conflict on an approved PR, from merge readiness or the PR's mergeable state (#2393754)", async () => {
    const approved = {
      binks: "success" as const,
      ci: "success" as const,
      reviews: [{ state: "APPROVED", at: "2026-11-11T23:11:03Z", by: human("aaron.casanova") }],
    };
    const state = await refresh({
      authored: [
        { number: 2393754, ...approved, blockers: [{ code: "conflict" }] },
        { number: 2393755, ...approved, pull: { mergeable: false, mergeable_state: "dirty" } },
      ],
    });
    for (const number of [2393754, 2393755]) {
      const pr = row(state, number);
      expect(pr.group).toBe("blocked");
      expect(pr.blockedBy).toEqual(["Conflict"]);
      expect(pr.status).toMatch(/^Blocked: Conflict · Approved by aaron\.casanova/);
    }
  });

  it("re-reads mergeability while Delta reports it unknown", async () => {
    const state = await refresh({
      authored: [
        {
          number: 2393754,
          ci: "success",
          reviews: [{ state: "APPROVED", at: "2026-11-11T23:11:03Z", by: human("aaron.casanova") }],
          blockersByRead: [[], [{ code: "conflict" }]],
        },
      ],
    });
    expect(row(state, 2393754).blockedBy).toEqual(["Conflict"]);
  });

  it("keeps a conflict seen on the same head while Delta is recomputing mergeability", async () => {
    const base = {
      number: 2393754,
      head: "df78f23",
      binks: "success" as const,
      ci: "success" as const,
      reviews: [{ state: "APPROVED", at: "2026-11-11T23:11:03Z", by: human("aaron.casanova") }],
    };
    const runtime = await loadRuntime(
      fakeDelta({ authored: [{ ...base, blockers: [{ code: "conflict" }] }] }),
    );
    expect(row(await runtime.refresh(), 2393754).blockedBy).toEqual(["Conflict"]);

    runtime.swap(fakeDelta({ authored: [base] }));
    expect(row(await runtime.refresh(), 2393754).blockedBy).toEqual(["Conflict (as of last pull)"]);

    runtime.swap(fakeDelta({ authored: [{ ...base, head: "new-push" }] }));
    expect(row(await runtime.refresh(), 2393754).group).toBe("ready_to_merge");
  });

  it("does not count bot-only approvals", async () => {
    const state = await refresh({
      authored: [
        {
          number: 2417300,
          binks: "success",
          ci: "success",
          reviews: [{ state: "APPROVED", at: "2026-11-11T22:50:12Z", by: BINKS }],
          blockers: [{ code: "required_check_pending", context: `${BINKS_CTX}:reviews` }],
        },
      ],
    });
    const pr = row(state, 2417300);
    expect(pr.group).toBe("waiting_on_review");
    expect(pr.review).toBe("needs_approval");
    expect(pr.status).toContain("Needs approval (only Binks approved)");
  });

  it("does not count approvals Delta marked stale or dismissed", async () => {
    const state = await refresh({
      authored: [
        {
          number: 1,
          ci: "success",
          reviews: [{ state: "APPROVED", at: "2026-11-10T10:00:00Z", by: human("aaron.casanova") }],
          stances: [
            {
              author: human("aaron.casanova").login,
              counts: false,
              current: false,
              state: "approved",
            },
          ],
        },
        {
          number: 2,
          ci: "success",
          reviews: [
            { state: "DISMISSED", at: "2026-11-10T10:00:00Z", by: human("matt.dentremont") },
          ],
          stances: [],
        },
      ],
    });
    expect(row(state, 1).group).toBe("waiting_on_review");
    expect(row(state, 1).ignoredApprovals).toEqual([
      { by: "aaron.casanova", reason: "not counted by Delta" },
    ]);
    expect(row(state, 2).group).toBe("waiting_on_review");
    expect(row(state, 2).ignoredApprovals).toEqual([
      { by: "matt.dentremont", reason: "dismissed" },
    ]);
  });

  it("lets a newer human change request override an approval; an older one only blocks", async () => {
    const state = await refresh({
      authored: [
        {
          number: 10,
          ci: "success",
          reviews: [
            { state: "APPROVED", at: "2026-11-10T10:00:00Z", by: human("aaron.casanova") },
            {
              state: "CHANGES_REQUESTED",
              at: "2026-11-10T11:00:00Z",
              by: human("matt.dentremont"),
            },
          ],
        },
        {
          number: 11,
          ci: "success",
          reviews: [
            {
              state: "CHANGES_REQUESTED",
              at: "2026-11-10T09:00:00Z",
              by: human("matt.dentremont"),
            },
            { state: "APPROVED", at: "2026-11-10T10:00:00Z", by: human("aaron.casanova") },
          ],
        },
        {
          number: 12,
          ci: "success",
          reviews: [
            { state: "APPROVED", at: "2026-11-10T10:00:00Z", by: human("aaron.casanova") },
            { state: "CHANGES_REQUESTED", at: "2026-11-10T11:00:00Z", by: BINKS },
          ],
        },
      ],
    });
    expect(row(state, 10).group).toBe("waiting_on_review");
    expect(row(state, 10).review).toBe("changes_requested");
    expect(row(state, 10).status).toContain("Changes requested by matt.dentremont");
    expect(row(state, 10).status).not.toContain("Needs approval");
    expect(row(state, 11).group).toBe("blocked");
    expect(row(state, 11).blockedBy).toEqual(["Changes requested by matt.dentremont"]);
    expect(row(state, 12).group).toBe("ready_to_merge");
  });

  it("tracks River PRs assigned to me as my own PRs, marked as River", async () => {
    const state = await refresh({
      authored: [],
      assigned: [
        {
          number: 2394891,
          user: RIVER_USER,
          ci: "success",
          reviews: [{ state: "APPROVED", at: "2026-11-10T10:00:00Z", by: human("aaron.casanova") }],
        },
        { number: 2394892, user: RIVER_USER, draft: true },
        { number: 2394893, user: { login: "kenza.iraki@shopify.com" } },
      ],
    });
    expect(state.authored.map((r) => [r.number, r.group, r.ownership, r.authorBrand])).toEqual([
      [2394891, "ready_to_merge", "assigned", "River"],
      [2394892, "draft", "assigned", "River"],
    ]);
  });

  it("shows a River PR that is assigned to me and requests my review once, as my own", async () => {
    const riverPr: Pr = { number: 2140845, user: RIVER_USER, ci: "success" };
    const otherRiverPr: Pr = { number: 2140846, user: RIVER_USER };
    const state = await refresh({
      authored: [],
      assigned: [riverPr],
      requested: [riverPr, otherRiverPr],
    });
    expect(state.authored.map((r) => r.number)).toEqual([2140845]);
    expect(row(state, 2140845).group).toBe("waiting_on_review");
    expect(state.reviewRequests.map((r) => r.number)).toEqual([2140846]);
  });

  describe("lanes", () => {
    const approved = {
      binks: "success" as const,
      ci: "success" as const,
      reviews: [{ state: "APPROVED", at: "2026-11-11T20:00:00Z", by: human("aaron.casanova") }],
    };
    const gardenStop = {
      at: "2026-11-11T22:30:00Z",
      brand: "Merge Garden",
      body: "❌ **Waiting for CI failed**\n\nThis pull request has been ejected.",
    };

    it("puts every real blocker in Blocked and names it on the row", async () => {
      const state = await refresh({
        authored: [
          { number: 1, ...approved, ci: undefined, failingCheck: "Required CI" },
          { number: 2, ...approved, binks: "failure" },
          { number: 3, ...approved, blockers: [{ code: "conflict" }] },
          { number: 4, ...approved, comments: [gardenStop] },
          { number: 5, ...approved, threads: 2 },
          { number: 6, ...approved, blockers: [{ code: "restricted_merge_window" }] },
        ],
      });
      const reasons = Object.fromEntries(
        state.authored.map((r) => [r.number, [r.lanes, r.blockReasons]]),
      );
      expect(reasons).toEqual({
        1: [["blocked"], ["Failing: Required CI"]],
        2: [["blocked"], ["1 open Binks finding"]],
        3: [["blocked"], ["Conflict"]],
        4: [["blocked"], ["Merge stopped: Waiting for CI failed"]],
        5: [["blocked"], ["2 unresolved threads"]],
        6: [["blocked"], ["Restricted merge window"]],
      });
      for (const r of state.authored) {
        expect(r.status).toMatch(/^Blocked: /);
        expect(r.fixKey).not.toBeNull();
      }
    });

    it("counts a conflict as of the last pull as a blocker (#2391479, #2362902)", async () => {
      const base = { number: 2391479, head: "58a67ba", ...approved, ci: "pending" as const };
      const runtime = await loadRuntime(
        fakeDelta({ authored: [{ ...base, blockers: [{ code: "conflict" }] }] }),
      );
      await runtime.refresh();
      runtime.swap(fakeDelta({ authored: [base] }));
      const pr = row(await runtime.refresh(), 2391479);
      expect(pr.lanes).toEqual(["blocked"]);
      expect(pr.blockReasons).toEqual(["Conflict (as of last pull)"]);
    });

    it("puts a pending check in CI pending, never in Blocked", async () => {
      const state = await refresh({
        authored: [
          // Binks still reviewing and CI running.
          {
            number: 10,
            ...approved,
            binks: "pending",
            ci: "running",
            blockers: [
              {
                code: "required_status_pending",
                context: `${BINKS_CTX}:PR Review Bot Comments Addressed`,
              },
              { code: "required_status_pending", context: `${CI_CTX}:Required CI` },
            ],
          },
          // Required CI has not run yet and nothing else is pending: /merge runs it.
          {
            number: 11,
            ...approved,
            ci: "pending",
            blockers: [{ code: "required_status_pending", context: `${CI_CTX}:Required CI` }],
          },
        ],
      });
      const pending = row(state, 10);
      expect(pending.lanes).toEqual(["ci_pending"]);
      expect(pending.blockedBy).toEqual([]);
      expect(pending.blockReasons).toEqual([]);
      expect(pending.pending).toEqual(["CI running", "Binks reviewing"]);
      expect(pending.status).not.toContain("Blocked");
      expect(pending.status).toContain("Binks reviewing · CI running");
      expect(pending.fixKey).toBeNull();
      expect(row(state, 11).lanes).toEqual(["ready_to_merge"]);
      expect(row(state, 11).status).toContain("CI not run");
    });

    it("lets Blocked win over CI pending (#2393754: conflict, Binks pending, CI not run)", async () => {
      const state = await refresh({
        authored: [
          {
            number: 2393754,
            ...approved,
            binks: "pending",
            ci: "running",
            blockers: [
              { code: "conflict" },
              {
                code: "required_status_pending",
                context: `${BINKS_CTX}:PR Review Bot Comments Addressed`,
              },
              { code: "required_status_pending", context: `${CI_CTX}:Required CI` },
            ],
          },
        ],
      });
      const pr = row(state, 2393754);
      expect(pr.lanes).toEqual(["blocked"]);
      expect(pr.blockReasons).toEqual(["Conflict"]);
      expect(pr.pending).toEqual(["CI running", "Binks reviewing"]);
      expect(pr.status).toMatch(/^Blocked: Conflict · Approved by aaron\.casanova/);
    });

    it("lists an unapproved, blocked PR in Blocked and Waiting on review, and nothing else twice (#2407660)", async () => {
      const runtime = await loadRuntime(
        fakeDelta({
          authored: [
            {
              number: 2407660,
              binks: "failure",
              failingCheck: "Required CI",
              threads: 1,
              blockers: [{ code: "conflict" }],
            },
            // Unapproved and only pending: Waiting on review alone.
            { number: 2407467, ci: "running", binks: "pending" },
            { number: 2417300, ...approved, reviews: [] },
            { number: 30, ...approved },
            { number: 31, ...approved, ci: "running" },
            { number: 32, ...approved, draft: true, binks: "failure" },
          ],
        }),
      );
      const state = await runtime.refresh();
      const lanes = Object.fromEntries(state.authored.map((r) => [r.number, r.lanes]));
      expect(lanes).toEqual({
        2407660: ["blocked", "waiting_on_review"],
        2407467: ["waiting_on_review"],
        2417300: ["waiting_on_review"],
        30: ["ready_to_merge"],
        31: ["ci_pending"],
        32: ["draft"],
      });
      const dual = row(state, 2407660);
      expect(dual.group).toBe("blocked");
      expect(dual.blockReasons).toEqual([
        "Conflict",
        "Failing: Required CI",
        "1 open Binks finding",
        "1 unresolved thread",
      ]);
      expect(dual.status).toContain("Needs approval");

      const numbers = (prs: { number: number }[]) => prs.map((r) => r.number);
      const all = await runtime.listAll();
      expect(Object.keys(all.groups)).toEqual([
        "merging",
        "ready_to_merge",
        "blocked",
        "ci_pending",
        "waiting_on_review",
        "draft",
        "waiting_on_my_review",
      ]);
      expect(numbers(all.groups.blocked)).toEqual([2407660]);
      expect(numbers(all.groups.waiting_on_review)).toEqual([2407660, 2407467, 2417300]);
      expect(numbers(all.groups.ci_pending)).toEqual([31]);
      expect(all.groups.blocked[0].lanes).toEqual(["blocked", "waiting_on_review"]);
      const summary = await runtime.summary();
      expect(summary.counts).toEqual({
        merging: 0,
        ready_to_merge: 1,
        blocked: 1,
        ci_pending: 1,
        waiting_on_review: 3,
        draft: 1,
        waiting_on_my_review: 0,
      });
      expect(summary.text).toContain("(1 both blocked and waiting on review)");
    });
  });

  describe("merging", () => {
    const garden = (at: string, body: string) => ({ at, brand: "Merge Garden", body });
    const command = (at: string, body: string) => ({ at, body });
    const approved = {
      ci: "success" as const,
      head: "12684ca9b1bf5e2f4f87ca54b51e3897b0adee89",
      reviews: [{ state: "APPROVED", at: "2026-11-11T20:00:00Z", by: human("aaron.casanova") }],
    };
    const conflictEjection = (sha: string) =>
      garden(
        "2026-11-11T22:30:00Z",
        `❌ **Merge conflict**\n\n<details>\n- PR head: [\`${sha}\`](https://delta.shopify.io/shop/world/commit/${sha})\n</details>\n\nThis pull request has been ejected.`,
      );

    it("puts PRs Merge Garden accepted and has in flight in Merging, ahead of every other group", async () => {
      const state = await refresh({
        authored: [
          {
            number: 1,
            ...approved,
            blockers: [{ code: "required_check_missing", context: `${BINKS_CTX}:reviews` }],
            comments: [
              command("2026-11-11T22:24:19Z", "/merge"),
              garden(
                "2026-11-11T22:24:27Z",
                "👀 **Waiting for CI**\n\nThe pull request is waiting",
              ),
            ],
          },
          {
            number: 2,
            ...approved,
            comments: [
              command("2026-11-11T17:14:20Z", "/merge"),
              garden(
                "2026-11-11T17:14:24Z",
                "✅ **Pull request enqueued successfully**\n\nThe pull request",
              ),
            ],
          },
        ],
      });
      expect(row(state, 1).group).toBe("merging");
      expect(row(state, 1).status).toMatch(
        /^Merging: waiting for CI · Approved by aaron\.casanova/,
      );
      expect(row(state, 1).status).not.toContain("blocked");
      expect(row(state, 2).group).toBe("merging");
      expect(row(state, 2).status).toMatch(/^Merging: in merge queue/);
    });

    it("moves an ejected PR to its real group and shows why it was ejected", async () => {
      const head = approved.head;
      const state = await refresh({
        authored: [
          // Conflict on the current head: blocked until a new push.
          {
            number: 10,
            ...approved,
            comments: [
              command("2026-11-11T22:24:19Z", "/merge"),
              conflictEjection(head.slice(0, 7)),
            ],
          },
          // Conflict on an older head: the push since then cleared it.
          { number: 11, ...approved, comments: [conflictEjection("9b96e7e")] },
          {
            number: 12,
            ...approved,
            comments: [
              command("2026-11-03T02:42:11Z", "/merge"),
              garden(
                "2026-11-03T02:42:15Z",
                "❌ **Could not enqueue pull request**\n\nThis pull request is not enqueueable for the following reasons:\n\n  - Pull request contents are too old: head commit age is 102841 seconds",
              ),
            ],
          },
        ],
      });
      expect(row(state, 10).group).toBe("blocked");
      expect(row(state, 10).blockedBy).toEqual(["Merge queue conflict"]);
      expect(row(state, 10).status).toContain("Merge stopped: Merge conflict ·");
      expect(row(state, 11).group).toBe("ready_to_merge");
      expect(row(state, 11).status).toContain(
        "Merge stopped: Merge conflict (before the latest push)",
      );
      // Any other current stop blocks until a new /merge.
      expect(row(state, 12).lanes).toEqual(["blocked"]);
      expect(row(state, 12).status).toContain(
        "Blocked: Merge stopped: Could not enqueue pull request: Pull request contents are too old",
      );
    });

    it("does not count an unanswered /merge or a cancelled merge as merging", async () => {
      const state = await refresh({
        authored: [
          { number: 20, ...approved, comments: [command("2026-11-11T23:40:43Z", "/merge")] },
          {
            number: 21,
            ...approved,
            comments: [
              garden("2026-11-11T22:24:27Z", "👀 **Waiting for CI**"),
              command("2026-11-11T22:30:00Z", "/cancel-merge"),
            ],
          },
          {
            number: 22,
            ...approved,
            comments: [garden("2026-11-11T22:24:27Z", "🛠️ **Something new**")],
          },
        ],
      });
      expect(row(state, 20).group).toBe("ready_to_merge");
      expect(row(state, 20).status).toContain("/merge sent, no Merge Garden reply");
      expect(row(state, 21).group).toBe("ready_to_merge");
      expect(row(state, 21).status).toContain("Merge cancelled (/cancel-merge)");
      expect(row(state, 22).group).toBe("ready_to_merge");
      expect(row(state, 22).status).toContain("Merge Garden: Something new");
    });
  });

  describe("merge button (/merge post, stubbed)", () => {
    const ready: Pr = {
      number: 30,
      ci: "success",
      binks: "success",
      reviews: [{ state: "APPROVED", at: "2026-11-11T20:00:00Z", by: human("aaron.casanova") }],
    };
    const blockedPr: Pr = { ...ready, number: 31, blockers: [{ code: "conflict" }] };
    const scenario = { authored: [ready, blockedPr] };

    async function readyRuntime(post: PostStub) {
      const runtime = await loadRuntime(fakeDelta(scenario, post));
      await runtime.refresh();
      return runtime;
    }

    it("posts exactly /merge and shows the row as Merging until the next refresh", async () => {
      const post: PostStub = { commands: [] };
      const runtime = await readyRuntime(post);
      expect(row(runtime.state(), 30).group).toBe("ready_to_merge");

      const result = await runtime.mergePr(30);
      expect(post.commands).toEqual([
        "/Users/user/.local/state/tec/toolchain/base_profile/bin/dt pr comment 30 -R shop/world --body '/merge'",
      ]);
      expect(result).toMatchObject({ posted: true, number: 30, comment: "/merge" });
      expect(Object.keys(runtime.state().mergeOverrides)).toEqual(["30"]);
      const merging = await runtime.listPrs("merging");
      expect(merging.prs.map((r: { number: number }) => r.number)).toEqual([30]);
      expect(merging.prs[0].mergeRequestedAt).toBe(result.at);
      expect((await runtime.listPrs("ready_to_merge")).prs).toEqual([]);
      // The override is local: live grouping is untouched.
      expect(row(runtime.state(), 30).group).toBe("ready_to_merge");
    });

    it("refuses rows outside Ready to merge, untracked PRs and repeats, without posting", async () => {
      const post: PostStub = { commands: [] };
      const runtime = await readyRuntime(post);
      await expect(runtime.mergePr(31)).rejects.toThrow(/not in Ready to merge \(group: blocked\)/);
      await expect(runtime.mergePr(99)).rejects.toThrow(/not one of the tracked PRs/);
      await runtime.mergePr(30);
      await expect(runtime.mergePr(30)).rejects.toThrow(/already waiting for the next refresh/);
      expect(post.commands).toHaveLength(1);
    });

    it("posts once when clicked twice while the first post is in flight", async () => {
      let finish: (value: { exitCode: number; stderr: string }) => void = () => {};
      const post: PostStub = {
        commands: [],
        result: () => new Promise((resolve) => (finish = resolve)),
      };
      const runtime = await readyRuntime(post);
      const first = runtime.mergePr(30);
      await vi.waitFor(() => expect(post.commands).toHaveLength(1));
      await expect(runtime.mergePr(30)).rejects.toThrow(/already being posted/);
      finish({ exitCode: 0, stderr: "" });
      await expect(first).resolves.toMatchObject({ posted: true });
      expect(post.commands).toHaveLength(1);
    });

    it("keeps no override when the post fails", async () => {
      const post: PostStub = {
        commands: [],
        result: async () => ({ exitCode: 1, stderr: "Error: 403 Forbidden" }),
      };
      const runtime = await readyRuntime(post);
      await expect(runtime.mergePr(30)).rejects.toThrow(
        "Could not post /merge on #30: exit 1 — Error: 403 Forbidden",
      );
      expect(runtime.state().mergeOverrides).toEqual({});
      expect(
        (await runtime.listPrs("ready_to_merge")).prs.map((r: { number: number }) => r.number),
      ).toEqual([30]);
    });

    it("drops the override on the next refresh and shows live Merge Garden state", async () => {
      const garden = (at: string, body: string) => ({ at, brand: "Merge Garden", body });
      const now = () => new Date().toISOString();
      const outcomes: [string, Pr["comments"], string][] = [
        [
          "merging",
          [{ at: now(), body: "/merge" }, garden(now(), "👀 **Waiting for CI**")],
          "merging",
        ],
        [
          "ejected",
          [
            { at: now(), body: "/merge" },
            garden(
              now(),
              "❌ **Merge conflict**\n\n- PR head: [`abc1234`](x)\n\nThis pull request has been ejected.",
            ),
          ],
          "blocked",
        ],
        ["no reply yet", [{ at: now(), body: "/merge" }], "ready_to_merge"],
      ];
      for (const [, comments, group] of outcomes) {
        const post: PostStub = { commands: [] };
        const runtime = await readyRuntime(post);
        await runtime.mergePr(30);
        runtime.swap(fakeDelta({ authored: [{ ...ready, head: "abc1234def", comments }] }, post));
        const state = await runtime.refresh();
        expect(state.mergeOverrides).toEqual({});
        expect(row(state, 30).group).toBe(group);
        if (group === "ready_to_merge") {
          // An unanswered /merge keeps the button hidden for a while: no duplicate post.
          expect(Date.parse(row(state, 30).mergeRequestPendingUntil ?? "")).toBeGreaterThan(
            Date.now(),
          );
          await expect(runtime.mergePr(30)).rejects.toThrow(/waiting for Merge Garden's reply/);
        }
        expect(post.commands).toHaveLength(1);
      }
    });

    it("keeps an override posted while a refresh was already running", async () => {
      const post: PostStub = { commands: [] };
      const runtime = await readyRuntime(post);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const base = fakeDelta(scenario, post);
      runtime.swap(async (name, input) => {
        if (input.command.includes("author:@me")) await gate;
        return base(name, input);
      });
      const refreshing = runtime.refresh();
      await runtime.mergePr(30);
      release();
      const state = await refreshing;
      expect(Object.keys(state.mergeOverrides)).toEqual(["30"]);
    });
  });
});

describe("Delta PRs projects and Fix (chat.prompt stubbed)", () => {
  const projectPath = (name: string) => {
    const project = PROJECTS.find((p) => p.name === name);
    if (!project) throw new Error(`No project ${name}`);
    return project.path;
  };
  const approvedReview = [
    { state: "APPROVED", at: "2026-11-11T20:00:00Z", by: human("aaron.casanova") },
  ];
  // Blocked by a conflict, in self-healing and system/agents; the title names self-healing.
  const blockedPr: Pr = {
    number: 41,
    title: "Self-Healing: give every goal an owner",
    labels: ["//system/agents", "//system/self-healing"],
    ci: "success",
    binks: "success",
    reviews: approvedReview,
    blockers: [{ code: "conflict" }],
  };
  const ciPr: Pr = {
    number: 42,
    title: "Goals search: match every word",
    labels: ["//system/self-healing"],
    binks: "success",
    failingCheck: "Required CI",
    reviews: approvedReview,
  };
  const binksPr: Pr = {
    number: 43,
    title: "Recover reactive queries after network errors",
    labels: ["//areas/clients/admin-web"],
    binks: "failure",
    reviews: approvedReview,
  };
  const readyPr: Pr = {
    number: 44,
    labels: ["//system/self-healing"],
    ci: "success",
    binks: "success",
    reviews: approvedReview,
  };
  const waitingPr: Pr = { number: 45, labels: ["//system/self-healing"], binks: "success" };
  const draftPr: Pr = { number: 46, labels: ["//system/self-healing"], draft: true };
  const scenario = { authored: [blockedPr, ciPr, binksPr, readyPr, waitingPr, draftPr] };

  async function fixRuntime(chat: ChatStub, authored: Pr[] = scenario.authored) {
    const runtime = await loadRuntime(fakeDelta({ authored }, undefined, chat));
    await runtime.refresh();
    return runtime;
  }

  it("maps PRs to registered projects by zone label, then changed paths, then title prefix", async () => {
    const chat: ChatStub = { prompts: [], filesRead: [] };
    const runtime = await loadRuntime(
      fakeDelta(
        {
          authored: [
            blockedPr,
            // No labels: changed paths decide, most-touched project first.
            {
              number: 50,
              files: [
                "areas/clients/admin-web/app/a.ts",
                "areas/clients/admin-web/app/b.ts",
                "system/agents/dist/skill.md",
              ],
            },
            // Imported (files 404) and unlabeled: the title prefix decides.
            { number: 2189563, title: "self-healing: request Binks alongside re-reviews" },
            // Nothing matches a registered project.
            { number: 51, title: "Rollouts: simplify discount lookup", files: ["areas/core/x.ts"] },
          ],
          requested: [{ number: 60, labels: ["//areas/clients/admin-web"] }],
        },
        undefined,
        chat,
      ),
    );
    const state = await runtime.refresh();
    const projects = (n: number) => row(state, n).projects?.map((p) => p.name);
    expect(projects(41)).toEqual(["self-healing", "system-agents"]);
    expect(row(state, 41).projectSource).toBe("label");
    expect(projects(50)).toEqual(["admin-web", "system-agents"]);
    expect(row(state, 50).projectSource).toBe("files");
    expect(projects(2189563)).toEqual(["self-healing"]);
    expect(row(state, 2189563).projectSource).toBe("title");
    expect(projects(51)).toEqual([]);
    expect(row(state, 51).projectSource).toBeNull();
    expect(state.reviewRequests[0]?.projects?.map((p) => p.name)).toEqual(["admin-web"]);
    // Labeled PRs cost no extra Delta call.
    expect(chat.filesRead?.toSorted((a, b) => a - b)).toEqual([50, 51, 2189563]);
  });

  it("keeps refreshing with unknown projects when Cake's project list fails", async () => {
    const chat: ChatStub = {
      prompts: [],
      projects: async () => {
        throw new Error("bridge unavailable");
      },
    };
    const runtime = await fixRuntime(chat, [blockedPr]);
    expect(row(runtime.state(), 41).projects).toBeNull();
    expect(runtime.state().warnings).toContain("Could not read Cake projects: bridge unavailable");
    expect(await runtime.requestFix({ numbers: [41], source: "row" })).toMatchObject({
      skipped: [{ number: 41, code: "no_project" }],
    });
    expect(chat.prompts).toEqual([]);
  });

  it("offers Fix only for Blocked rows", async () => {
    const chat: ChatStub = { prompts: [] };
    const runtime = await fixRuntime(chat);
    const groups = Object.fromEntries(runtime.state().authored.map((r) => [r.number, r.group]));
    expect(groups).toEqual({
      41: "blocked",
      42: "blocked",
      43: "blocked",
      44: "ready_to_merge",
      45: "waiting_on_review",
      46: "draft",
    });
    expect(row(runtime.state(), 44).fixKey).toBeNull();
    const result = await runtime.requestFix({ numbers: [44, 45, 46, 99], source: "fix_all" });
    expect(result.requested).toEqual([]);
    expect(result.skipped.map((s: { number: number; code: string }) => [s.number, s.code])).toEqual(
      [
        [44, "group"],
        [45, "group"],
        [46, "group"],
        [99, "untracked"],
      ],
    );
    // A Ready to merge row with /merge just requested from the widget shows as Merging: no Fix.
    expect(chat.prompts).toEqual([]);
  });

  it("sends one message per project with each PR's link, group and concrete reason", async () => {
    const chat: ChatStub = { prompts: [] };
    const runtime = await fixRuntime(chat);
    const result = await runtime.requestFix({ numbers: [41, 42, 43], source: "fix_all" });
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(chat.prompts.map((p) => p.sessionId)).toEqual([
      "project-chat:self-healing",
      "project-chat:admin-web",
    ]);
    const [selfHealing, adminWeb] = chat.prompts.map((p) => p.text);
    expect(selfHealing).toBe(
      [
        "Sergey clicked Fix all in the Delta PRs widget. Treat this as his request: please fix these 2 PRs in self-healing.",
        "",
        "- #41 Self-Healing: give every goal an owner",
        "  https://delta.shopify.io/shop/world/pull/41",
        "  Blocked: Blocked by Conflict",
        "- #42 Goals search: match every word",
        "  https://delta.shopify.io/shop/world/pull/42",
        "  Blocked: Failing checks: Required CI",
        "",
        "The widget posted nothing to Delta.",
      ].join("\n"),
    );
    expect(adminWeb).toContain("Sergey clicked Fix all");
    expect(adminWeb).toContain("this PR in admin-web");
    expect(adminWeb).toContain("- #43 Recover reactive queries after network errors");
    expect(adminWeb).toContain("Blocked: 1 open Binks finding");
    expect(
      result.requested.map((q: { number: number; chatId: string }) => [q.number, q.chatId]),
    ).toEqual([
      [41, "project-chat:self-healing"],
      [42, "project-chat:self-healing"],
      [43, "project-chat:admin-web"],
    ]);
    expect(Object.keys(runtime.state().fixRequests).toSorted()).toEqual(["41", "42", "43"]);
    expect((await runtime.listPrs("blocked")).prs[0].fixRequestedAt).toBe(result.requested[0].at);
  });

  it("sends a PR in several projects to the viewed project's chat", async () => {
    const chat: ChatStub = { prompts: [] };
    const runtime = await fixRuntime(chat);
    await runtime.requestFix({
      numbers: [41],
      projectPath: projectPath("system-agents"),
      source: "row",
    });
    expect(chat.prompts.map((p) => p.sessionId)).toEqual(["project-chat:system-agents"]);
    expect(chat.prompts[0]?.text).toMatch(/^Sergey clicked Fix in the Delta PRs widget\./);
    // A project the PR does not belong to falls back to its primary project.
    await runtime.requestFix({
      numbers: [43],
      projectPath: projectPath("self-healing"),
      source: "row",
    });
    expect(chat.prompts[1]?.sessionId).toBe("project-chat:admin-web");
  });

  it("never sends a PR twice: repeats, double clicks and Fix all after a single Fix", async () => {
    let admit: (value: unknown) => void = () => {};
    const chat: ChatStub = {
      prompts: [],
      result: () => new Promise((done) => (admit = done)),
    };
    const runtime = await fixRuntime(chat);
    const first = runtime.requestFix({ numbers: [41], source: "row" });
    await vi.waitFor(() => expect(chat.prompts).toHaveLength(1));
    // A second click while the first message is still being admitted.
    expect(await runtime.requestFix({ numbers: [41], source: "row" })).toMatchObject({
      requested: [],
      skipped: [{ number: 41, code: "sending" }],
    });
    admit({ ok: true, turnId: "t1" });
    await first;
    // Fix all afterwards sends only the PRs not already requested.
    chat.result = undefined;
    const all = await runtime.requestFix({ numbers: [41, 42], source: "fix_all" });
    expect(all.skipped).toMatchObject([{ number: 41, code: "requested" }]);
    expect(all.requested.map((q: { number: number }) => q.number)).toEqual([42]);
    expect(chat.prompts).toHaveLength(2);
    expect(chat.prompts[1]?.text).toContain("#42");
    expect(chat.prompts[1]?.text).not.toContain("#41");
    // A refresh with unchanged state keeps the hold.
    await runtime.refresh();
    expect(Object.keys(runtime.state().fixRequests).toSorted()).toEqual(["41", "42"]);
    expect(await runtime.requestFix({ numbers: [41, 42], source: "fix_all" })).toMatchObject({
      requested: [],
    });
    expect(chat.prompts).toHaveLength(2);
  });

  it("allows Fix again once the PR's state changes or the hold expires", async () => {
    const chat: ChatStub = { prompts: [] };
    const runtime = await fixRuntime(chat);
    await runtime.requestFix({ numbers: [41, 42], source: "fix_all" });
    expect(chat.prompts).toHaveLength(1);
    // #41 gets a new head commit (still conflicting): its hold is dropped on refresh.
    runtime.swap(
      fakeDelta({ authored: [{ ...blockedPr, head: "pushed" }, ciPr] }, undefined, chat),
    );
    const state = await runtime.refresh();
    expect(Object.keys(state.fixRequests)).toEqual(["42"]);
    await runtime.requestFix({ numbers: [41], source: "row" });
    expect(chat.prompts).toHaveLength(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 121 * 60_000);
      const late = await runtime.requestFix({ numbers: [42], source: "row" });
      expect(late.requested.map((q: { number: number }) => q.number)).toEqual([42]);
      expect(chat.prompts).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records nothing when a send fails, and reports which PRs failed", async () => {
    const chat: ChatStub = {
      prompts: [],
      result: async ({ sessionId }) => {
        if (sessionId === "project-chat:admin-web") throw new Error("Chat is unavailable");
        return { ok: true, turnId: "t1" };
      },
    };
    const runtime = await fixRuntime(chat);
    const result = await runtime.requestFix({ numbers: [41, 43], source: "fix_all" });
    expect(result.requested.map((q: { number: number }) => q.number)).toEqual([41]);
    expect(result.failed).toEqual([
      { number: 43, error: "Could not message the admin-web chat: Chat is unavailable" },
    ]);
    expect(Object.keys(runtime.state().fixRequests)).toEqual(["41"]);
    // The failed PR can be retried.
    chat.result = undefined;
    const retry = await runtime.requestFix({ numbers: [43], source: "row" });
    expect(retry.requested.map((q: { number: number }) => q.number)).toEqual([43]);
  });

  it("sends a PR in Blocked and Waiting on review once from Fix all", async () => {
    const chat: ChatStub = { prompts: [] };
    const dual: Pr = { ...blockedPr, reviews: [] };
    const runtime = await fixRuntime(chat, [dual]);
    expect(row(runtime.state(), 41).lanes).toEqual(["blocked", "waiting_on_review"]);
    const result = await runtime.requestFix({ numbers: [41, 41], source: "fix_all" });
    expect(result.requested.map((q: { number: number }) => q.number)).toEqual([41]);
    expect(chat.prompts).toHaveLength(1);
    expect(chat.prompts[0]?.text.match(/#41 /g)).toHaveLength(1);
  });

  it("does not post anything to Delta", async () => {
    const post: PostStub = { commands: [] };
    const chat: ChatStub = { prompts: [], shell: [] };
    const runtime = await loadRuntime(fakeDelta(scenario, post, chat));
    await runtime.refresh();
    const reads = chat.shell?.length;
    await runtime.requestFix({ numbers: [41, 42, 43], source: "fix_all" });
    expect(chat.prompts).toHaveLength(2);
    expect(chat.shell?.length).toBe(reads);
    expect(post.commands).toEqual([]);
  });
});
