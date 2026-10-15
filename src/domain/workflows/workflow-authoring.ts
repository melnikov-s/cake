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

Workers have project context and relevant skills, but no Cake application controls, parent messaging or recursive delegation. They share the owner's Working Directory: context isolation is not file isolation. Group related files, avoid parallel overlapping edits, and do not promise automatic worktree isolation or merging. Stopping/restarting does not undo edits.

Pause holds new admission while active workers finish; Resume continues scheduling. Stop cancels queued work and requests active cancellation, retaining completed results. Relaunch replays the frozen script and reuses only the matching successful prefix in call-start order. The first changed/failed step and all later steps run again. This is not a VM snapshot. Make editing steps safe against already-applied changes.

An explicit user request chooses workflow execution: use workflows.start without another confirmation. When you recommend orchestration in normal conversation, prepare the script then call workflows.propose with the same sessionId/scriptPath/args. Cake displays Run workflow, Continue normally, and View script with frozen source and phases. No sandbox or workers start before Run workflow. choice normal means continue agent-led work; choice cancelled starts nothing. Do not substitute a prose yes/no question or infer consent from your own text. After choosing workflow there are no routine per-script/phase/worker/retry/tool approvals and no permanent dynamic mode. Do not ask for mid-run human input: use separate runs when a later stage depends on a user decision.

Return one final JSON-compatible report (a string is fine), including failed/unverified coverage rather than treating null as proof of success. Intermediate results remain inside the script. Use workflows.saved and workflows.save to discover/reuse project or personal scripts; edit a saved script before a new run, not during live execution.
`;
