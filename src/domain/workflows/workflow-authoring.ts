export const workflowAuthoringReference = `# Workflow API

Write .js in the owner's Working Directory. First statement:
export const meta = { name: "audit", description: "Audit routes", phases: ["Review", "Verify"] };

Top-level await/return; args is launch JSON.
- await agent(prompt, { label?, instructions?, model?, schema?, stallMs? }): Pi worker; schema returns validated JSON, otherwise string. Default stall 600000ms excluding tools. Omit model unless requested; No silent model substitution.
- await pipeline(items, async (item,index) => ...), await parallel([async()=>...]): ordered results, null for failures.
- await phase(title), await log(message): progress.

No direct filesystem/shell/network/timers/imports or ambient clock/random; use agents or explicit args.
CPU-bounded admissions (default max 16), helpers max 4096 items, run max 1000 workers.
Workers share cwd: context isolation is not file isolation. No Cake controls/recursive delegation. Avoid overlapping edits; no automatic worktree isolation or undo.
Pause holds admissions; active workers finish. Stop cancels pending/active work, keeping results. Relaunch reuses matching successful prefix in call-start order; changed/failed steps onward rerun. This is not a VM snapshot; tolerate existing effects.

Explicit request: workflows.start directly. Recommendation: workflows.propose; Nothing starts before Run workflow. choice normal stays agent-led; choice cancelled starts nothing. No mid-run human input; split at decisions.
Return JSON-compatible report with failures/gaps; null never proves success. workflows.saved/save discovers/saves scripts. Never edit during execution.
`;
