export const workflowAuthoringReference = `# Cake workflow scripts

Write a .js file in the owning Project Session's Working Directory. Its first statement must be:
export const meta = { name: "audit-routes", description: "Audit route authentication", phases: ["Review", "Verify"] };

The body is plain JavaScript with top-level await and return. Available APIs:
- args: JSON input supplied at launch.
- await agent(prompt, { label?, instructions?, model?, schema?, stallMs? }): isolated-context Pi worker. model is a Cake preset name or explicit configuration; omit it unless the user asked for a specific model, and the run's start-time default preset is used. A schema returns validated JSON; otherwise the answer is a string. Default stall window 600000ms, excluding tool execution. No silent model substitution.
- await pipeline(items, async (item, index) => ...): fan out items; results preserve ordering and null slots for failed workers.
- await parallel([async () => ..., async () => ...]): parallel tasks with the same null-slot behavior.
- await phase(title): label following work in progress details.
- await log(message): bounded progress note, not the parent conversation.

There is no direct filesystem, shell, network, timers or module loading. Agents perform those operations. Date.now(), Math.random(), Date() and new Date() without arguments are disabled; pass explicit timestamps in args.

Admission is bounded by the backend (default up to 16 workers, reduced for available CPUs), helpers reject more than 4096 items, and a run can schedule at most 1000 workers. Do not use an agent just to count simple deterministic facts if inventory is already available in args.

Workers have project context/skills, no Cake controls, parent messaging or recursive delegation. They share the owner's Working Directory: context isolation is not file isolation. Group related files; avoid overlapping parallel edits. No automatic worktree isolation/merging. Stopping/restarting never undoes edits.

Pause holds admissions while active workers finish; Resume schedules again. Stop cancels queued work, requests active cancellation and retains completed results. Relaunch replays frozen source, reusing only the matching successful prefix in call-start order. The first changed/failed step and everything after it rerun. This is not a VM snapshot; edits must tolerate already-applied changes.

An explicit user workflow request authorizes workflows.start without reconfirmation. For your own orchestration recommendation, prepare the script and call workflows.propose with the same sessionId/scriptPath/args. Cake shows Run workflow, Continue normally and View script with frozen source/phases. Nothing starts before Run workflow. choice normal continues agent-led work; choice cancelled starts nothing. Never substitute prose yes/no approval or infer consent from your own text. Once chosen, no routine script/phase/worker/retry/tool approvals or permanent dynamic mode. No mid-run human input: split runs when later stages need a user decision.

Return one JSON-compatible report (a string is fine) including failed/unverified coverage; null never proves success. Intermediate results stay in the script. Discover/reuse project or personal scripts with workflows.saved and workflows.save. Edit before new runs, never during execution.
`;
