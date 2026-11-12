// Delta PR tracker runtime (async factory body). Lexical: cake, data.
const DT = "/Users/user/.local/state/tec/toolchain/base_profile/bin/dt";
const CWD = "/Users/user/world/trees/self-healing/src";
const ENV = {
  PATH: "/Users/user/.local/state/tec/toolchain/base_profile/bin:/Users/user/.local/state/nix/profiles/tec/bin:/opt/dev/bin/user:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
};
const JQ = "/opt/homebrew/bin/jq";
const REPO = "shop/world";

// ---- Review-counting rules: one switch each. -------------------------------------------
// Bot and app accounts (Binks, River, Self-Healing Bot, any service account) never count as approvers.
const BOT_APPROVALS_COUNT = false;
// An approval Delta dismissed (review state DISMISSED / dismissed_by set) does not count.
const DISMISSED_APPROVALS_COUNT = false;
// An approval Delta itself reports as not counting (merge-readiness stance counts:false,
// e.g. made stale by a push when the branch dismisses stale reviews) does not count.
const TRUST_DELTA_NOT_COUNTED = true;
// An approval on an older commit still counts while Delta keeps counting it. shop/world has
// dismiss_stale_reviews off, so Delta keeps those approvals (counts:true, current:false).
const APPROVALS_ON_OLDER_COMMITS_COUNT = true;
// A human changes-requested review newer than the latest counting approval sends the PR back
// to Waiting on review with status "Changes requested".
const NEWER_CHANGES_REQUEST_OVERRIDES_APPROVAL = true;
// Required CI that has not run yet / is still running does not block: Merge Garden runs full CI on /merge.
const REQUIRED_CI_NOT_RUN_BLOCKS = false;
// Delta recomputes mergeability whenever main moves; until it finishes, merge readiness drops its
// "conflict" blocker and reports mergeability unknown. A conflict is read from merge readiness or the
// PR's mergeable_state "dirty"; while both say unknown, a conflict the previous pull saw on the same
// head commit is kept (shown as "Conflict (as of last pull)").
const KEEP_CONFLICT_WHILE_MERGEABILITY_UNKNOWN = true;
// Extra reads of merge readiness + the PR when both report mergeability unknown.
const MERGEABILITY_RETRIES = 2;
// PRs authored by these Delta apps and assigned to me are tracked as my own PRs.
const OWN_ASSIGNED_AUTHOR_BRANDS = ["River"];
// Logins that identify service/bot accounts when Delta reports them as type "User".
const BOT_LOGIN_PATTERNS = [/\.iam\.gserviceaccount\.com$/i, /\[bot\]$/i];
// ---- Merging: read from Merge Garden's own PR comments (its web/API needs a browser login). --
const MERGE_GARDEN_BRAND = "Merge Garden";
// Latest Merge Garden comment headings that mean the PR is in flight (accepted /merge, not yet
// landed or ejected). Any other heading is shown as-is and never counts as merging.
const MERGING_HEADINGS = [
  { re: /^Waiting for CI$/i, phase: "waiting for CI" },
  { re: /enqueued/i, phase: "in merge queue" },
];
// Headings/bodies that mean Merge Garden stopped the merge (ejected, could not enqueue, cancelled).
const MERGE_STOPPED = /has been ejected|^Could not|^Merge conflict|failed|cancel/i;
// A merge-queue conflict ejection blocks the PR until a new commit is pushed (the comment names
// the PR head it conflicted on).
const MERGE_CONFLICT_EJECTION_BLOCKS = true;
// ---- Merge button: posts exactly this comment, nothing else. -------------------------------
const MERGE_COMMENT = "/merge";
const MERGE_POST_TIMEOUT = 30;
// After an unanswered /merge (no Merge Garden reply yet), hide the Merge button this long so a
// second click cannot post a duplicate while Merge Garden is still picking it up.
const MERGE_REPLY_WAIT_MINUTES = 10;
// ------------------------------------------------------------------------------------------

// jq filters (no single quotes) that slim dt JSON below shell.run's 50 KiB stdout cap.
const PR_FIELDS =
  "{number,title,draft,updated_at,created_at,user:{login:.user.login,service_brand:.user.service_brand},assignees:[.assignees[]?|{login}],requested_reviewers:[.requested_reviewers[]?|{login}],requested_teams:[.requested_teams[]?|{slug,name}]}";
const SEARCH_FILTER = `{total_count,items:[.items[]|${PR_FIELDS}]}`;
const CHECKS_FILTER =
  "{check_runs:[.check_runs[]?|{name,status,conclusion,output:{title:.output.title}}],statuses:{state:.statuses.state,statuses:[.statuses.statuses[]?|{context,state,description,creator:{login:.creator.login,service_brand:.creator.service_brand}}]}}";
const READINESS_FILTER =
  "{head,mergeable,merge_state_status,blockers,reviews:{approved:.reviews.approved,changes_requested:.reviews.changes_requested,unresolved_threads:.reviews.unresolved_threads,stances:[.reviews.stances[]?|{author,commit,counts,current,state}]},status_check_rollup:{state:.status_check_rollup.state,contexts:[.status_check_rollup.contexts[]?|{name,present,status,conclusion}]}}";
const REVIEWS_FILTER =
  "[.[]|{state,submitted_at,commit_id,dismissed:(.dismissed_by != null),user:{login:.user.login,type:.user.type,brand:.user.service_brand.display_name}}]";
const PULL_FILTER = "{mergeable,mergeable_state,comments}";
const COMMENTS_FILTER =
  '[.[]|select((.user.service_brand.display_name // "") == "Merge Garden" or (.body // "" | startswith("/merge") or startswith("/cancel-merge")))|{at:.created_at,brand:.user.service_brand.display_name,login:.user.login,body:((.body // "")[0:1500])}]';
const SCHEMA = "delta-pr-tracker/v1";
const GROUPS = [
  "merging",
  "ready_to_merge",
  "blocked",
  "binks_comments",
  "ci_failing",
  "waiting_on_review",
  "draft",
  "waiting_on_my_review",
];
const LIST_TIMEOUT = 45;
const PR_TIMEOUT = 30;
const CONCURRENCY = 4;
const BINKS_CONTEXT = "PR Review Bot Comments Addressed";
const FAILED_CONCLUSIONS = [
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
];
const CONTEXT_LABELS = { [BINKS_CONTEXT]: "Binks comments", reviews: "reviews" };

const prUrl = (n) => `https://delta.shopify.io/shop/world/pull/${n}`;

function stderrSummary(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^=+$/.test(l))
    .filter(
      (l) =>
        !/SUBOPTIMAL GIT|^Recommended:|packfile-URI|clones, fetches|^Install with:|^Put that Git|^Continuing with the same/.test(
          l,
        ),
    );
  return lines.slice(-3).join(" | ").slice(0, 400);
}

// Run one dt command, optionally slimming stdout with jq while preserving dt's exit code.
// Returns {exitCode, stdout, stderr, label}. Throws on timeout/truncation.
async function dt(args, timeoutSeconds, jqFilter) {
  const command = jqFilter
    ? `out=$(${DT} ${args}); code=$?; if [ -n "$out" ]; then printf "%s" "$out" | ${JQ} -c '${jqFilter}' || exit 97; fi; exit $code`
    : `${DT} ${args}`;
  const r = await cake("shell.run", { command, cwd: CWD, timeoutSeconds, env: ENV });
  const label = `dt ${args.replace(/\s+--json$/, "").slice(0, 120)}`;
  if (r.timedOut) throw new Error(`${label}: timed out after ${timeoutSeconds}s`);
  if (r.stdoutTruncated) throw new Error(`${label}: JSON output exceeded the 50 KiB limit`);
  if (r.exitCode === 97)
    throw new Error(`${label}: could not parse dt output with jq — ${stderrSummary(r.stderr)}`);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, label };
}

// dt JSON call that accepts some exit codes when stdout is JSON.
async function dtJson(args, timeoutSeconds, okExits, jqFilter) {
  const r = await dt(args, timeoutSeconds, jqFilter);
  const ok = (okExits || [0]).includes(r.exitCode);
  const body = String(r.stdout || "").trim();
  if (ok && body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`${r.label}: invalid JSON (${String(e && e.message)})`);
    }
  }
  throw new Error(
    `${r.label}: exit ${r.exitCode}${stderrSummary(r.stderr) ? " — " + stderrSummary(r.stderr) : ""}`,
  );
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(n, items.length); w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const k = next++;
          try {
            out[k] = { ok: true, value: await fn(items[k], k) };
          } catch (e) {
            out[k] = { ok: false, error: String((e && e.message) || e) };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

const brandOf = (user) => (user && user.service_brand && user.service_brand.display_name) || null;
const authorName = (user) => {
  if (!user) return "unknown";
  return brandOf(user) || String(user.login || "unknown").replace(/@.*$/, "");
};
const shortLogin = (login) => String(login || "unknown").replace(/@.*$/, "");

const isImported = (n) => n >= 2000000 && n < 2200000;
const contextName = (ctx) => String(ctx || "").replace(/^.*:/, "");

function ciPhrase(requiredCi) {
  if (!requiredCi) return "CI not run";
  if (requiredCi.state === "success") return "CI passed";
  if (requiredCi.state === "failure" || requiredCi.state === "error") return "CI failed";
  if (/not yet run/i.test(requiredCi.description || "")) return "CI not run";
  return "CI running";
}

// A reviewer is a bot when Delta says so, when the account carries an app brand (Binks,
// River, Self-Healing Bot), or when its login is a service account.
function isBotReviewer(reviewer) {
  if (!reviewer) return false;
  if (reviewer.type === "Bot" || reviewer.brand) return true;
  return BOT_LOGIN_PATTERNS.some((re) => re.test(String(reviewer.login || "")));
}

// Decide whether a human has approved the PR.
// reviews: Delta reviews API rows (or null when unavailable); readiness: merge-readiness (or null).
// Returns {review: approved|changes_requested|needs_approval|unknown, approvedBy, changesRequestedBy,
//          olderChangesRequestedBy, ignoredApprovals: [{by, reason}], source}.
function reviewVerdict(reviews, readiness) {
  const readinessReviews = readiness && readiness.reviews;
  const stances = new Map();
  for (const s of (readinessReviews && readinessReviews.stances) || []) stances.set(s.author, s);

  let rows;
  let source;
  if (Array.isArray(reviews)) {
    source = "reviews";
    rows = reviews.map((r) => ({
      login: r.user && r.user.login,
      type: r.user && r.user.type,
      brand: r.user && r.user.brand,
      state: String(r.state || "").toUpperCase(),
      at: r.submitted_at || null,
      dismissed: !!r.dismissed,
    }));
  } else if (readinessReviews && Array.isArray(readinessReviews.stances)) {
    // Fallback without timestamps or app brands: stance per author, bots recognized by login.
    source = "stances";
    rows = readinessReviews.stances.map((s) => ({
      login: s.author,
      type: null,
      brand: null,
      state: String(s.state || "").toUpperCase(),
      at: null,
      dismissed: false,
    }));
  } else {
    return {
      review: "unknown",
      approvedBy: [],
      changesRequestedBy: [],
      olderChangesRequestedBy: [],
      ignoredApprovals: [],
      source: null,
    };
  }

  // Latest decisive review per reviewer; comments do not change a reviewer's stance.
  const latest = new Map();
  rows
    .filter((r) => r.login && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
    .forEach((r) => latest.set(r.login, r));

  const approvals = [];
  const changes = [];
  const ignoredApprovals = [];
  for (const r of latest.values()) {
    const stance = stances.get(r.login);
    const bot = isBotReviewer(r);
    if (r.state === "APPROVED") {
      let reason = null;
      if (bot && !BOT_APPROVALS_COUNT) reason = "bot";
      else if (r.dismissed && !DISMISSED_APPROVALS_COUNT) reason = "dismissed";
      else if (stance && stance.counts === false && TRUST_DELTA_NOT_COUNTED)
        reason = "not counted by Delta";
      else if (stance && stance.current === false && !APPROVALS_ON_OLDER_COMMITS_COUNT)
        reason = "older commit";
      if (reason)
        ignoredApprovals.push({
          by: bot ? r.brand || shortLogin(r.login) : shortLogin(r.login),
          reason,
        });
      else approvals.push(r);
    } else if (r.state === "DISMISSED") {
      if (!DISMISSED_APPROVALS_COUNT)
        ignoredApprovals.push({ by: r.brand || shortLogin(r.login), reason: "dismissed" });
    } else if (!bot && !r.dismissed) {
      changes.push(r);
    }
  }

  const newest = (list) => list.reduce((m, r) => (r.at && (!m || r.at > m) ? r.at : m), null);
  const lastApproval = newest(approvals);
  const isNewer = (r) => !r.at || !lastApproval || r.at > lastApproval; // unknown time: assume newer
  const overriding =
    approvals.length === 0
      ? changes
      : NEWER_CHANGES_REQUEST_OVERRIDES_APPROVAL
        ? changes.filter(isNewer)
        : [];
  const names = (list) => list.map((r) => shortLogin(r.login));

  let review;
  if (overriding.length > 0) review = "changes_requested";
  else if (approvals.length > 0) review = "approved";
  else review = "needs_approval";
  return {
    review,
    approvedBy: names(approvals),
    changesRequestedBy: names(overriding),
    olderChangesRequestedBy: review === "approved" ? names(changes) : [],
    ignoredApprovals,
    source,
  };
}

function blockerPhrase(b) {
  if (b.code === "conflict") return "Conflict";
  const m = /^required_(check|status)_(missing|pending|failing)$/.exec(b.code || "");
  const label = CONTEXT_LABELS[b.context] || b.context;
  if (m) return `${label} ${m[1]} ${m[2]}`;
  const words = String(b.code || "blocked").replace(/_/g, " ");
  return b.context ? `${label}: ${words}` : words.charAt(0).toUpperCase() + words.slice(1);
}

// "conflict" | "clean" | "unknown" from merge readiness and the PR's own mergeability.
function mergeStateOf(readiness, pull) {
  const r = readiness || {};
  const p = pull || {};
  if (
    (r.blockers || []).some((b) => b.code === "conflict") ||
    r.merge_state_status === "dirty" ||
    (p.mergeable === false && p.mergeable_state === "dirty")
  )
    return "conflict";
  if (r.mergeable === true || p.mergeable === true) return "clean";
  return "unknown";
}

// Plain-words merge blockers, excluding ones another part of the status already explains.
function mergeBlockers(blockers, mergeState, failing, verdict) {
  const out = [];
  if (mergeState === "conflict") out.push("Conflict");
  else if (mergeState === "conflict_last_pull") out.push("Conflict (as of last pull)");
  for (const b of blockers) {
    if (b.code === "draft" || b.code === "conflict") continue;
    if (
      b.context === "Required CI" &&
      /_(pending|missing)$/.test(b.code) &&
      !REQUIRED_CI_NOT_RUN_BLOCKS
    )
      continue;
    if (failing.includes(b.context)) continue;
    // Without a counting approval, the reviews check is explained by "Needs approval".
    if (b.context === "reviews" && verdict.review !== "approved") continue;
    out.push(blockerPhrase(b));
  }
  for (const who of verdict.olderChangesRequestedBy) out.push(`Changes requested by ${who}`);
  return out;
}

// Merge Garden state from its comments and /merge, /cancel-merge commands (oldest first).
// Returns {state: none|merging|stopped|requested|cancelled|other|unknown, phase?, reason?, at?, conflictHead?}.
function mergeGardenState(comments) {
  if (!Array.isArray(comments)) return { state: "unknown" };
  const sorted = comments.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = (pred) => sorted.filter(pred).pop() || null;
  const fromGarden = (c) => c.brand === MERGE_GARDEN_BRAND;
  const garden = last(fromGarden);
  const mergeCmd = last((c) => !fromGarden(c) && /^\/merge\b/.test(c.body));
  const cancelCmd = last((c) => !fromGarden(c) && /^\/cancel-merge\b/.test(c.body));
  if (!garden && !mergeCmd && !cancelCmd) return { state: "none" };
  if (cancelCmd && (!garden || cancelCmd.at > garden.at))
    return { state: "cancelled", reason: "/cancel-merge", at: cancelCmd.at };
  if (mergeCmd && (!garden || mergeCmd.at > garden.at))
    return { state: "requested", at: mergeCmd.at };
  const heading = String(garden.body.split("\n")[0] || "")
    .replace(/\*\*/g, "")
    .replace(/^[^A-Za-z]+/, "")
    .trim();
  const merging = MERGING_HEADINGS.find((h) => h.re.test(heading));
  if (merging) return { state: "merging", phase: merging.phase, at: garden.at };
  if (MERGE_STOPPED.test(heading) || /has been ejected/i.test(garden.body)) {
    const bullet = /^\s*-\s+([^:\n]+)/m.exec(garden.body);
    const head = /PR head: \[`([0-9a-f]{7,40})`\]/.exec(garden.body);
    return {
      state: "stopped",
      reason: bullet && /^Could not/i.test(heading) ? `${heading}: ${bullet[1].trim()}` : heading,
      at: garden.at,
      conflict: /conflict/i.test(heading),
      conflictHead: head ? head[1] : null,
    };
  }
  return { state: "other", reason: heading, at: garden.at };
}

function reviewPhrase(verdict, draft) {
  if (verdict.review === "approved") return `Approved by ${verdict.approvedBy.join(", ")}`;
  if (verdict.review === "changes_requested")
    return `Changes requested by ${verdict.changesRequestedBy.join(", ")}`;
  if (verdict.review === "unknown") return "Review state unavailable";
  if (draft) return null;
  const bots = verdict.ignoredApprovals.filter((a) => a.reason === "bot").map((a) => a.by);
  const others = verdict.ignoredApprovals
    .filter((a) => a.reason !== "bot")
    .map((a) => `${a.by}, ${a.reason}`);
  const why = [];
  if (bots.length) why.push(`only ${[...new Set(bots)].join(", ")} approved`);
  if (others.length) why.push(`not counted: ${others.join("; ")}`);
  return `Needs approval${why.length ? ` (${why.join("; ")})` : ""}`;
}

// Group one of my own PRs (authored by me, or authored by an app like River and assigned to me).
// details: {checks, readiness, reviews, pull} — each null when it failed to load.
// previous: this PR's row from the last successful pull, or null.
function classifyOwn(pr, details, notes, ownership, previous) {
  const { checks, readiness, reviews, pull, comments } = details;
  const runs = (checks && checks.check_runs) || [];
  const statuses = (checks && checks.statuses && checks.statuses.statuses) || [];
  const binksStatus = statuses.find(
    (s) =>
      s.context === BINKS_CONTEXT ||
      (s.creator && s.creator.service_brand && s.creator.service_brand.display_name === "Binks"),
  );
  const requiredCi = statuses.find((s) => s.context === "Required CI") || null;
  const reviewsRun = runs.find((r) => r.name === "reviews") || null;

  let binks = { state: "missing", findings: 0, description: "" };
  if (binksStatus) {
    const m = /(\d+)\s+open\s+Binks\s+finding/i.exec(binksStatus.description || "");
    binks = {
      state: binksStatus.state,
      findings: binksStatus.state === "failure" ? (m ? Number(m[1]) : 1) : 0,
      description: binksStatus.description || "",
    };
  } else if (readiness) {
    const ctx = ((readiness.status_check_rollup || {}).contexts || []).find(
      (c) => c.name === BINKS_CONTEXT,
    );
    if (ctx && ctx.present)
      binks.state =
        ctx.conclusion === "failure" ? "failure" : ctx.conclusion || ctx.status || "pending";
    if (binks.state === "failure") binks.findings = 1;
  }

  const failing = [];
  for (const r of runs) {
    if (r.name === "reviews") continue;
    if (r.status === "completed" && FAILED_CONCLUSIONS.includes(r.conclusion)) failing.push(r.name);
  }
  for (const s of statuses) {
    if (s === binksStatus) continue;
    if (s.state === "failure" || s.state === "error") failing.push(s.context);
  }

  const readinessReviews = (readiness && readiness.reviews) || {};
  const unresolvedThreads = Number(readinessReviews.unresolved_threads || 0);
  const blockers = ((readiness && readiness.blockers) || []).map((b) => ({
    code: b.code,
    context: contextName(b.context),
  }));
  const verdict = reviewVerdict(reviews, readiness);
  const head = (readiness && readiness.head) || null;
  let mergeState = mergeStateOf(readiness, pull);
  if (
    mergeState === "unknown" &&
    KEEP_CONFLICT_WHILE_MERGEABILITY_UNKNOWN &&
    previous &&
    head &&
    previous.head === head &&
    (previous.mergeState === "conflict" || previous.mergeState === "conflict_last_pull")
  )
    mergeState = "conflict_last_pull";
  const blockedBy = mergeBlockers(blockers, mergeState, failing, verdict);
  if (!readiness && verdict.review === "approved") blockedBy.push("merge readiness unavailable");
  const merge = mergeGardenState(comments);
  if (
    merge.state === "stopped" &&
    merge.conflict &&
    MERGE_CONFLICT_EJECTION_BLOCKS &&
    head &&
    merge.conflictHead &&
    head.startsWith(merge.conflictHead) &&
    !blockedBy.some((b) => /^Conflict/.test(b))
  )
    blockedBy.push("Merge queue conflict");

  let group;
  if (pr.draft) group = "draft";
  else if (merge.state === "merging") group = "merging";
  else if (binks.state === "failure") group = "binks_comments";
  else if (failing.length > 0) group = "ci_failing";
  else if (verdict.review !== "approved") group = "waiting_on_review";
  else if (blockedBy.length > 0) group = "blocked";
  else group = "ready_to_merge";

  const bits = [];
  if (group === "merging") bits.push(`Merging: ${merge.phase}`);
  if (group === "blocked") bits.push(`Blocked: ${blockedBy.join(", ")}`);
  if (merge.state === "stopped") {
    const pushedSince = merge.conflictHead && head && !head.startsWith(merge.conflictHead);
    bits.push(`Merge stopped: ${merge.reason}${pushedSince ? " (before the latest push)" : ""}`);
  } else if (merge.state === "cancelled") bits.push("Merge cancelled (/cancel-merge)");
  else if (merge.state === "requested") bits.push("/merge sent, no Merge Garden reply");
  else if (merge.state === "other") bits.push(`Merge Garden: ${merge.reason}`);
  if (failing.length) bits.push(`Failing: ${failing.join(", ")}`);
  if (binks.state === "failure")
    bits.push(`${binks.findings} open Binks finding${binks.findings === 1 ? "" : "s"}`);
  const rp = reviewPhrase(verdict, pr.draft);
  if (rp) bits.push(rp);
  if (binks.state === "success") bits.push("Binks clear");
  else if (binks.state === "pending") bits.push("Binks reviewing");
  if (!failing.includes("Required CI")) bits.push(ciPhrase(requiredCi));
  if (group !== "blocked" && group !== "draft" && group !== "merging" && blockedBy.length)
    bits.push(`Also blocked: ${blockedBy.join(", ")}`);
  if (unresolvedThreads > 0)
    bits.push(`${unresolvedThreads} unresolved thread${unresolvedThreads === 1 ? "" : "s"}`);
  if (isImported(pr.number)) bits.unshift("Imported from Meteorite (read-only)");
  for (const n of notes) bits.push(n);

  return {
    number: pr.number,
    title: pr.title,
    url: prUrl(pr.number),
    group,
    status: bits.join(" · "),
    draft: !!pr.draft,
    imported: isImported(pr.number),
    author: authorName(pr.user),
    authorBrand: brandOf(pr.user),
    ownership,
    updatedAt: pr.updated_at || null,
    createdAt: pr.created_at || null,
    review: verdict.review,
    approvals: verdict.approvedBy.length,
    approvedBy: verdict.approvedBy,
    changesRequestedBy: verdict.changesRequestedBy,
    ignoredApprovals: verdict.ignoredApprovals,
    reviewSource: verdict.source,
    deltaApprovals: Number(readinessReviews.approved || 0),
    reviewsCheck: reviewsRun ? reviewsRun.conclusion || reviewsRun.status || null : null,
    blockedBy,
    merge,
    // Until this time the Merge button stays hidden: a /merge is already waiting for Merge Garden.
    mergeRequestPendingUntil:
      merge.state === "requested" && merge.at
        ? new Date(Date.parse(merge.at) + MERGE_REPLY_WAIT_MINUTES * 60000).toISOString()
        : null,
    head,
    mergeState,
    unresolvedThreads,
    binks,
    failingChecks: failing,
    ci: requiredCi ? { state: requiredCi.state, description: requiredCi.description || "" } : null,
    blockers: blockers.map((b) => (b.context ? `${b.context}:${b.code}` : b.code)),
  };
}

function classifyReviewRequest(pr, me) {
  const direct = (pr.requested_reviewers || []).some((u) => {
    const login = String(u.login || "");
    return login === me.login || login === me.email || login.replace(/@.*$/, "") === me.login;
  });
  const teams = (pr.requested_teams || []).map((t) => t.slug || t.name).filter(Boolean);
  const bits = [`by ${authorName(pr.user)}`];
  if (pr.draft) bits.push("Draft");
  bits.push(
    direct ? "requested from you" : teams.length ? `via team ${teams.join(", ")}` : "requested",
  );
  if (isImported(pr.number)) bits.push("Imported from Meteorite (read-only)");
  return {
    number: pr.number,
    title: pr.title,
    url: prUrl(pr.number),
    group: "waiting_on_my_review",
    status: bits.join(" · "),
    draft: !!pr.draft,
    imported: isImported(pr.number),
    author: authorName(pr.user),
    authorBrand: brandOf(pr.user),
    updatedAt: pr.updated_at || null,
    createdAt: pr.created_at || null,
    direct,
  };
}

// My own PRs: authored by me, plus PRs authored by an OWN_ASSIGNED_AUTHOR_BRANDS app and assigned
// to me. A PR is listed once; my own PRs never appear under review requests.
function ownPrs(mine, assigned, reviewing) {
  const own = mine.map((pr) => ({ pr, ownership: "author" }));
  const seen = new Set(mine.map((pr) => pr.number));
  for (const pr of assigned) {
    if (seen.has(pr.number) || !OWN_ASSIGNED_AUTHOR_BRANDS.includes(brandOf(pr.user))) continue;
    seen.add(pr.number);
    own.push({ pr, ownership: "assigned" });
  }
  return { own, reviewing: reviewing.filter((pr) => !seen.has(pr.number)) };
}

async function searchPrs(qualifier) {
  const q = `is:pr+is:open+${qualifier}+repo:shop/world`;
  const res = await dtJson(
    `api -R ${REPO} 'search/issues?q=${q}&per_page=100'`,
    LIST_TIMEOUT,
    [0],
    SEARCH_FILTER,
  );
  const items = (res && res.items) || [];
  return { items, total: typeof res.total_count === "number" ? res.total_count : items.length };
}

const settle = (p) =>
  p.then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e: String((e && e.message) || e) }),
  );

async function loadDetails(n) {
  const readReadiness = () =>
    settle(
      dtJson(
        `api -R ${REPO} repos/shop/world/pulls/${n}/merge-readiness`,
        PR_TIMEOUT,
        [0],
        READINESS_FILTER,
      ),
    );
  const readPull = () =>
    settle(dtJson(`api -R ${REPO} repos/shop/world/pulls/${n}`, PR_TIMEOUT, [0], PULL_FILTER));
  const [checks, readiness, reviews, pull] = await Promise.all([
    // dt pr checks: exit 0 all passed, 1 a check failed, 8 pending — all carry JSON.
    settle(dtJson(`pr checks ${n} -R ${REPO} --json`, PR_TIMEOUT, [0, 1, 8], CHECKS_FILTER)),
    readReadiness(),
    settle(
      dtJson(
        `api -R ${REPO} 'repos/shop/world/pulls/${n}/reviews?per_page=100'`,
        PR_TIMEOUT,
        [0],
        REVIEWS_FILTER,
      ),
    ),
    readPull(),
  ]);
  let comments = await settle(
    dtJson(
      `api -R ${REPO} 'repos/shop/world/issues/${n}/comments?per_page=100'`,
      PR_TIMEOUT,
      [0],
      COMMENTS_FILTER,
    ),
  );
  // Merge Garden's latest comment may sit beyond the first 100 comments: read the last page too.
  const commentCount = pull.ok ? Number(pull.v.comments || 0) : 0;
  if (comments.ok && commentCount > 100) {
    const lastPage = await settle(
      dtJson(
        `api -R ${REPO} 'repos/shop/world/issues/${n}/comments?per_page=100&page=${Math.ceil(commentCount / 100)}'`,
        PR_TIMEOUT,
        [0],
        COMMENTS_FILTER,
      ),
    );
    comments = lastPage.ok ? { ok: true, v: comments.v.concat(lastPage.v) } : lastPage;
  }
  const value = (x) => (x.ok ? x.v : null);
  // Delta recomputes mergeability as main moves; each read is an independent sample.
  let readinessValue = value(readiness);
  let pullValue = value(pull);
  for (
    let attempt = 0;
    attempt < MERGEABILITY_RETRIES && mergeStateOf(readinessValue, pullValue) === "unknown";
    attempt++
  ) {
    const [r, p] = await Promise.all([readReadiness(), readPull()]);
    if (r.ok && (!readinessValue || mergeStateOf(r.v, null) !== "unknown")) readinessValue = r.v;
    if (p.ok && mergeStateOf(null, p.v) !== "unknown") pullValue = p.v;
  }
  const notes = [];
  if (!comments.ok) notes.push("merge status failed to load");
  if (!checks.ok)
    notes.push(/404/.test(checks.e) ? "checks unavailable (404)" : "checks failed to load");
  if (!readinessValue) notes.push("merge readiness failed to load");
  if (!reviews.ok) notes.push("reviews failed to load");
  if (reviews.ok && Array.isArray(reviews.v) && reviews.v.length >= 100)
    notes.push("over 100 reviews; only the first 100 were read");
  const errors = [checks, reviews, comments]
    .filter((x) => !x.ok)
    .map((x) => x.e)
    .concat(readinessValue ? [] : [readiness.e], pullValue || pull.ok ? [] : [pull.e]);
  return {
    details: {
      checks: value(checks),
      readiness: readinessValue,
      reviews: value(reviews),
      pull: pullValue,
      comments: value(comments),
    },
    notes,
    errors,
  };
}

function emptyState(prev) {
  return {
    schema: SCHEMA,
    me: null,
    refreshedAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastDurationMs: null,
    lastSource: null,
    refreshing: null,
    warnings: [],
    authored: [],
    reviewRequests: [],
    history: [],
    // {"<number>": {at, pull}}: /merge posted from the widget; shown as Merging until a refresh
    // that started after the post resolves it. `pull` is the refreshStarts count at posting time.
    mergeOverrides: {},
    refreshStarts: 0,
    ...(prev && prev.schema === SCHEMA ? prev : {}),
  };
}

async function readState() {
  return emptyState(await data.read());
}

async function doRefresh(source) {
  const started = Date.now();
  const startedIso = new Date(started).toISOString();
  let state = await readState();
  const pull = (state.refreshStarts || 0) + 1;
  await data.write({
    ...state,
    refreshStarts: pull,
    refreshing: { startedAt: startedIso, source },
  });
  try {
    const me = await dtJson(`api -R ${REPO} /api/v3/user`, LIST_TIMEOUT, [0], "{login,email}");
    const meInfo = { login: me.login, email: me.email || null };
    const [mine, assigned, reviewing] = await Promise.all([
      searchPrs("author:@me"),
      searchPrs("assignee:@me"),
      searchPrs("review-requested:@me"),
    ]);
    const warnings = [];
    if (mine.total > mine.items.length)
      warnings.push(`Only the first ${mine.items.length} of ${mine.total} authored PRs are shown.`);
    if (assigned.total > assigned.items.length)
      warnings.push(
        `Only the first ${assigned.items.length} of ${assigned.total} assigned PRs were checked.`,
      );
    if (reviewing.total > reviewing.items.length)
      warnings.push(
        `Only the first ${reviewing.items.length} of ${reviewing.total} review requests are shown.`,
      );
    const { own, reviewing: requests } = ownPrs(mine.items, assigned.items, reviewing.items);

    const previous = new Map((state.authored || []).map((r) => [r.number, r]));
    const details = await pool(own, CONCURRENCY, async ({ pr, ownership }) => {
      const d = await loadDetails(pr.number);
      return {
        row: classifyOwn(pr, d.details, d.notes, ownership, previous.get(pr.number) || null),
        errors: d.errors,
      };
    });

    const authored = [];
    let perPrErrors = 0;
    details.forEach((d, i) => {
      if (d.ok) {
        authored.push(d.value.row);
        const real = d.value.errors.filter((e) => !/404/.test(e));
        perPrErrors += real.length;
        if (real.length) warnings.push(`#${own[i].pr.number}: ${real[0]}`);
      } else {
        perPrErrors++;
        warnings.push(`#${own[i].pr.number}: ${d.error}`);
      }
    });
    authored.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const reviewRequests = requests
      .map((pr) => classifyReviewRequest(pr, meInfo))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    const finished = Date.now();
    const assignedOwn = authored.filter((r) => r.ownership === "assigned").length;
    const entry = {
      at: new Date(finished).toISOString(),
      source,
      ok: true,
      durationMs: finished - started,
      authored: authored.length,
      assigned: assignedOwn,
      reviewRequests: reviewRequests.length,
      perPrErrors,
    };
    state = await readState();
    const next = {
      ...state,
      me: meInfo,
      refreshedAt: entry.at,
      lastAttemptAt: startedIso,
      lastError: null,
      lastDurationMs: entry.durationMs,
      lastSource: source,
      refreshing: null,
      warnings: warnings.slice(0, 20),
      authored,
      reviewRequests,
      history: [entry, ...(state.history || [])].slice(0, 20),
      // This pull resolves every override posted before it started; later posts wait for the next.
      refreshStarts: Math.max(state.refreshStarts || 0, pull),
      mergeOverrides: Object.fromEntries(
        Object.entries(state.mergeOverrides || {}).filter(([, o]) => o && o.pull >= pull),
      ),
    };
    await data.write(next);
    return next;
  } catch (e) {
    const message = String((e && e.message) || e);
    const finished = Date.now();
    state = await readState();
    await data.write({
      ...state,
      lastAttemptAt: startedIso,
      lastError: { at: new Date(finished).toISOString(), message, source },
      lastDurationMs: finished - started,
      lastSource: source,
      refreshing: null,
      history: [
        {
          at: new Date(finished).toISOString(),
          source,
          ok: false,
          durationMs: finished - started,
          error: message.slice(0, 300),
        },
        ...(state.history || []),
      ].slice(0, 20),
    });
    throw new Error(`Refresh failed: ${message}`);
  }
}

// A /merge posted from the widget shows the row as Merging until the next refresh resolves it.
const overrideOf = (state, row) => (state.mergeOverrides || {})[String(row.number)] || null;
const effectiveGroup = (state, row) => (overrideOf(state, row) ? "merging" : row.group);

// Why the Merge button is unavailable for a row, or null when /merge may be posted.
function mergeBlockedReason(state, row) {
  if (overrideOf(state, row))
    return "a /merge from this widget is already waiting for the next refresh";
  if (row.group !== "ready_to_merge") return `it is not in Ready to merge (group: ${row.group})`;
  if (row.mergeRequestPendingUntil && Date.now() < Date.parse(row.mergeRequestPendingUntil))
    return "a /merge is already waiting for Merge Garden's reply";
  return null;
}

const posting = new Set();

async function postMerge(n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid PR number: ${n}`);
  if (posting.has(n)) throw new Error(`#${n}: /merge is already being posted`);
  const state = await readState();
  const row = (state.authored || []).find((r) => r.number === n);
  if (!row) throw new Error(`#${n} is not one of the tracked PRs`);
  const blocked = mergeBlockedReason(state, row);
  if (blocked) throw new Error(`Not posting /merge on #${n}: ${blocked}`);
  posting.add(n);
  let r;
  try {
    r = await dt(`pr comment ${n} -R ${REPO} --body '${MERGE_COMMENT}'`, MERGE_POST_TIMEOUT);
  } catch (e) {
    const message = String((e && e.message) || e);
    throw new Error(
      /timed out/.test(message)
        ? `${message}. The comment may have been posted; check the PR before trying again.`
        : message,
    );
  } finally {
    posting.delete(n);
  }
  if (r.exitCode !== 0) {
    const why = stderrSummary(r.stderr);
    throw new Error(`Could not post /merge on #${n}: exit ${r.exitCode}${why ? ` — ${why}` : ""}`);
  }
  const at = new Date().toISOString();
  const latest = await readState();
  await data.write({
    ...latest,
    mergeOverrides: {
      ...(latest.mergeOverrides || {}),
      [String(n)]: { at, pull: latest.refreshStarts || 0 },
    },
  });
  return { posted: true, number: n, comment: MERGE_COMMENT, at, url: prUrl(n) };
}

function countsOf(state) {
  const counts = {};
  for (const g of GROUPS) counts[g] = 0;
  for (const r of state.authored || [])
    counts[effectiveGroup(state, r)] = (counts[effectiveGroup(state, r)] || 0) + 1;
  counts.waiting_on_my_review = (state.reviewRequests || []).length;
  return counts;
}

const slim = (r, state) => ({
  number: r.number,
  title: r.title,
  url: r.url,
  group: state ? effectiveGroup(state, r) : r.group,
  mergeRequestedAt: state && overrideOf(state, r) ? overrideOf(state, r).at : null,
  status: r.status,
  draft: r.draft,
  author: r.author,
  ownership: r.ownership || null,
  updatedAt: r.updatedAt,
});

function rowsFor(state, group) {
  if (group === "waiting_on_my_review")
    return (state.reviewRequests || []).map((r) => slim(r, null));
  return (state.authored || [])
    .filter((r) => effectiveGroup(state, r) === group)
    .map((r) => slim(r, state));
}

const meta = (state) => ({
  refreshedAt: state.refreshedAt,
  lastError: state.lastError ? state.lastError.message : null,
  lastErrorAt: state.lastError ? state.lastError.at : null,
});

return {
  tools: {
    refresh: async (input) => {
      const source = (input && input.source) || "agent";
      const s = await doRefresh(source);
      return {
        ok: true,
        ...meta(s),
        durationMs: s.lastDurationMs,
        counts: countsOf(s),
        warnings: s.warnings,
      };
    },
    list_prs: async (input) => {
      const state = await readState();
      const group = input && input.group;
      if (group) return { ...meta(state), group, prs: rowsFor(state, group) };
      const groups = {};
      for (const g of GROUPS) groups[g] = rowsFor(state, g);
      return { ...meta(state), groups };
    },
    summary: async () => {
      const state = await readState();
      const counts = countsOf(state);
      const parts = GROUPS.filter((g) => counts[g] > 0).map(
        (g) => `${counts[g]} ${g.replace(/_/g, " ")}`,
      );
      const ageMin = state.refreshedAt
        ? Math.round((Date.now() - Date.parse(state.refreshedAt)) / 60000)
        : null;
      return {
        ...meta(state),
        ageMinutes: ageMin,
        counts,
        text: state.refreshedAt
          ? `${(state.authored || []).length} open PRs of mine: ${parts.join(", ") || "none"}. Pulled ${ageMin} min ago${state.lastError ? `; last refresh failed: ${state.lastError.message}` : ""}.`
          : `Never refreshed${state.lastError ? `; last refresh failed: ${state.lastError.message}` : ""}.`,
        recentRuns: (state.history || []).slice(0, 5),
      };
    },
    // Widgets run in a sandboxed frame without allow-popups, so links cannot open
    // new windows. Open the PR in the default browser from the backend instead.
    open_pr: async (input) => {
      const n = input.number;
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid PR number: ${n}`);
      const url = prUrl(n);
      const r = await cake("shell.run", {
        command: `/usr/bin/open '${url}'`,
        cwd: CWD,
        timeoutSeconds: 10,
        env: ENV,
      });
      if (r.timedOut) throw new Error(`Opening ${url} timed out`);
      if (r.exitCode !== 0)
        throw new Error(
          `Could not open ${url}: ${(r.stderr || "").trim() || `exit ${r.exitCode}`}`,
        );
      return { opened: true, url };
    },
    // Posts exactly "/merge" as a PR comment (Merge Garden then queues it). Only for Ready to merge rows.
    merge_pr: async (input) => postMerge(input.number),
    get_pr: async (input) => {
      const state = await readState();
      const n = input.number;
      const row =
        (state.authored || []).find((r) => r.number === n) ||
        (state.reviewRequests || []).find((r) => r.number === n);
      return { ...meta(state), found: !!row, pr: row || null };
    },
  },
};
