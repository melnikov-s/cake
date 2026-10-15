import type { SubagentReportOrigin } from "../../src/contracts/subagents/subagent-data";

export const researchOrigin: SubagentReportOrigin = {
  handleId: "10000000-0000-4000-8000-000000000002",
  task: "Compare Godot and Three.js game-development workflows",
  status: "complete",
  resolvedModel: {
    requested: "current",
    source: "current",
    provider: "fixture",
    modelId: "fixture",
    thinkingLevel: "off",
    fallbacks: [],
  },
  fastMode: false,
  usage: { cost: 0.25 },
};

// Long assignment and findings modeled on the reported investigator screenshot.
export const investigatorOrigin: SubagentReportOrigin = {
  ...researchOrigin,
  task: "Read only, narrowly scoped: User asks what the unread update is in existing planner-worker prompt session s:b57b8ef1 titled 'Plan-and-work prompt: don't end the turn while builds run'. Read the latest assistant user-visible report(s) in its authoritative transcript at /sessions/planner-worker/2026-10-14T19-57-14-903Z.jsonl. Session last modified 2026-10-14T23:53:27Z, activity unread. Summarize latest substantive update in 5 bullets max: what completed, whether user's request to remove fixed hour/build/prototype limits and use generic runtime budget language was addressed, any commit/PR URL/push status, checks and blockers or pending action. Attribute as the session's report, don't independently investigate repository or remote state; do not restart or message the session, edit anything, or run tests. Include report timestamp if available. Inspect just transcript tail sufficient to answer.",
};

export const investigatorMarkdown = [
  "Latest session report: **2026-10-14 at 23:53:27 UTC**. Based only on its transcript:",
  "",
  "- **Completed:** Updated both planner-worker prompts, tests, docs, and PR description. The instructions to keep the turn alive while builds run remain intact.",
  "- **Runtime-budget request partly addressed:** Removed fixed build durations, estimated build counts, and the 25-minute cutoff. Guidance now uses elapsed time and measured build duration. **However, the transcript’s diff still retains ‘at most three prototypes per visit,’ so removing all fixed prototype limits was not completed.**",
  "- **Published:** Reports commit `a0d1494b`, rebased onto latest `origin/main` and pushed to both remotes.",
  "- **Checks reported passing:** Formatting, lint, type-check with zero errors, and API tests—90 files, 1,121 tests.",
  "",
  "Deterministic visual fixture based on the reported screenshot; not a live investigation.",
].join("\n");

export const researchMarkdown = [
  "## Game-development workflow comparison",
  "",
  "This is a deterministic UI fixture, not live research.",
  "",
  "- **Godot:** an integrated game editor and engine.",
  "- **Three.js:** a rendering library for browser-based experiences.",
  "",
  "### Example",
  "",
  "```ts",
  "const scene = new THREE.Scene();",
  "```",
  "",
  "Reference links: [Godot](https://godotengine.org) and [Three.js](https://threejs.org).",
  "",
  "Web access is not guaranteed; do not treat this fixture as retrieved evidence.",
].join("\n");
