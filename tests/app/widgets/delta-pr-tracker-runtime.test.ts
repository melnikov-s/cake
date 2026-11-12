import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  binks?: "success" | "failure" | "missing";
  // Merge Garden comments and /merge commands (already slimmed like the runtime's jq filter).
  comments?: { at: string; brand?: string | null; login?: string; body: string }[];
  ci?: "success" | "pending";
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
  };
}

function checksFor(pr: Pr) {
  const statuses: unknown[] = [];
  if (pr.binks && pr.binks !== "missing")
    statuses.push({
      context: "PR Review Bot Comments Addressed",
      state: pr.binks,
      description: pr.binks === "failure" ? "❌ 1 open Binks finding" : "No unresolved findings",
      creator: { login: BINKS.login, service_brand: { display_name: "Binks" } },
    });
  if (pr.ci)
    statuses.push({
      context: "Required CI",
      state: pr.ci,
      description: pr.ci === "success" ? "Passed" : "CI not yet run.",
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
      unresolved_threads: 0,
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

function fakeDelta(scenario: { authored: Pr[]; assigned?: Pr[]; requested?: Pr[] }) {
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
    expect(name).toBe("shell.run");
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
  status: string;
  review: string;
  approvedBy: string[];
  blockedBy: string[];
  ownership: string;
  authorBrand: string | null;
  ignoredApprovals: { by: string; reason: string }[];
};
type State = { authored: Row[]; reviewRequests: { number: number }[] };

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
  it("moves a human-approved PR with missing required checks out of Waiting on review (#2189563)", async () => {
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
    expect(pr.group).toBe("blocked");
    expect(pr.approvedBy).toEqual(["aaron.casanova"]);
    expect(pr.blockedBy).toEqual([
      "restricted-merges check missing",
      "reviews check missing",
      "Binks comments status missing",
    ]);
    expect(pr.status).toContain("Approved by aaron.casanova");
    expect(pr.status).not.toContain("Needs approval");
  });

  it("puts a PR with two human approvals on an older commit and a missing reviews check in Blocked (#2306172)", async () => {
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
    expect(pr.group).toBe("blocked");
    expect(pr.approvedBy).toEqual(["carlos.corvaia", "ryan.wilsonperkin"]);
    expect(pr.blockedBy).toEqual(["restricted-merges check missing", "reviews check missing"]);
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
      expect(row(state, 12).group).toBe("ready_to_merge");
      expect(row(state, 12).status).toContain(
        "Merge stopped: Could not enqueue pull request: Pull request contents are too old",
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
});
