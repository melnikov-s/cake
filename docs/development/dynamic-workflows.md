# Dynamic workflows

Cake workflows are script-driven, Project Session-owned background runs. Pi remains
responsible for each worker's reasoning, tools and transcript. Cake owns the
standalone `@earendil-works/pi-codemode` sandbox, scheduling, checkpoints and controls.

Implementation follows approved r1 and the accepted live-activity amendment.
Live worker projections use a transient supervisor channel, separate from durable
run checkpoints and Pi's transcript authority.

## Experimental opt-in

Dynamic workflows are **off by default**. Enable **Settings → Experimental → Dynamic
workflows** before using them. Availability is a persisted, application-wide setting,
not a permission prompt or an automatic classifier. Disabled sessions do not advertise
workflow operations; even existing runtimes update discovery when the setting changes.
The backend rejects proposals, direct launches and relaunches while disabled, before
reading scripts or creating runs. The renderer also hides execution-choice dialogs.
Turning the setting off cancels pending execution choices. Previously accepted runs
continue and retain progress/controls; disabling does not stop work or undo edits.

## Starting a run

With the experiment enabled, ask a Project Session to use a workflow, or accept its suggestion. This is a choice
of execution approach, not a permission mode: there are no subsequent routine
script, phase or worker approval prompts. Cake Chat can launch/control a workflow
in an explicitly targeted Project Session but cannot own its execution.

For an agent suggestion during normal conversation, prepare the script and call
`workflows.propose` with the same input shown below. Cake presents an interactive
choice with the workflow name/description, declared phases, **Run workflow**,
**Continue normally**, and **View script** (frozen source and args). Only Run
workflow launches that exact frozen program; source-file edits while the choice
is pending cannot change it. Continue normally returns `{ choice: "normal" }`
for agent-led work. Cancellation, Escape, dismissal, abort or disconnect starts
nothing. The request uses Cake's existing validated UI request correlation and
cancellation lifecycle, not a permanent mode or permission system. Cake Chat
can propose it but must target a Project Session execution owner.

An explicit user request to use a workflow already makes the execution choice:
call `workflows.start` directly without the extra interaction. Do not infer
consent from agent-written text or substitute a prose yes/no question. Once
chosen, no script/phase/worker/retry/tool approval prompts are introduced.

The agent can request `cake workflows.authoring`, write a JavaScript file, then call:

```json
{
  "command": "workflows.start",
  "input": {
    "sessionId": "<owning Project Session>",
    "scriptPath": "audit.js",
    "args": { "groups": ["src/routes/auth", "src/routes/api"] }
  }
}
```

Launch freezes the script and inputs and returns a run handle without awaiting
completion. Worker answers go back to the script, not into the parent's context.
The final report returns to the owning conversation, reassembling the normal
Project Session runtime if the launch turn and observers have ended. Failed
report delivery retries independently; it never reruns workers. Intermediate
activity and results remain inspectable through the workflow details; worker
transcripts remain Pi-owned after their ephemeral runtimes are released. Token
activity does not rewrite checkpoints; changed usage and lifecycle transitions do.

## Script shape

```javascript
export const meta = {
  name: "audit-auth",
  description: "Audit authentication and verify each finding",
  phases: ["Review", "Verify", "Report"],
};

await phase("Review");
const reviews = await pipeline(args.groups, (group) =>
  agent(`Review authentication in ${group}. Return evidence-backed findings.`, {
    label: group,
  }),
);

await phase("Verify");
const verified = await pipeline(reviews, (review) =>
  review === null ? null : agent(`Independently verify this review: ${JSON.stringify(review)}`),
);

await phase("Report");
return await agent(
  `Produce one report, including incomplete coverage: ${JSON.stringify(verified)}`,
);
```

The first statement must be a literal `export const meta` object with a name and
description. Metadata is parsed, never evaluated on the host. The body accepts
top-level await and return.

Available functions are `agent`, `pipeline`, `parallel`, `phase` and `log`, plus the
JSON `args` input. Agents may specify `label`, additional `instructions`, a Cake
model preset name or explicit model configuration, a JSON output `schema`, and
`stallMs`. Invalid output schemas are rejected before billed work. Structured
answers are validated with up to five answer attempts. Model selection never
silently substitutes another model.

The script cannot directly access the filesystem, shell, network, modules or
host process. Agents perform actual work. Clock/random access is disabled to
support replay; pass timestamps through `args`.

## Controls and recovery

- **Pause:** hold new worker admission. Active workers finish and checkpoint.
- **Resume:** continue scheduling, without duplicating active workers.
- **Stop:** cancel queued work and request active cancellation. Stopped is published
  only after worker cleanup; completed results remain available.
- **Stop worker:** cancel one step. Its result is null rather than completed work.
- **Restart worker:** restart from its assignment within six total attempts.
- **Relaunch:** replay a stopped, interrupted or completed run. Reuse the matching
  successful prefix in call-start order. The first changed/failed call and all later
  calls run again, including completed later siblings.

Recovery does not restore a frozen JavaScript VM. Backend restart leaves lost live
execution interrupted; it does not silently start another billed run. Editing the
source file does not mutate a running program. Relaunch may deliberately select
revised source; earlier frozen programs and worker references remain retained.

Cancellation and retries **do not undo filesystem changes**. A worker stall is
measured at the Pi boundary, excluding time spent in tools, with a default
600,000 ms window and at most five restarts. Batch helpers preserve null slots for
worker failures; directly awaited failures remain errors. Programmer errors and
storage failures are not silently treated as empty findings.

## Limits and saved scripts

Default concurrency is up to 16, reduced for available host CPUs. Set
`CAKE_WORKFLOW_MAX_CONCURRENT_AGENTS` to an integer from 1 to 256 to override it.
Helpers reject lists longer than 4,096. A run can schedule at most 1,000 agents.
Usage includes unsuccessful attempts and previous executions; cached replay does
not bill or recount old results.

`workflows.saved` discovers `.cake/workflows/*.js` between the Working Directory
and Project root, plus Cake's personal `workflows` directory. The closest project
definition wins and project definitions shadow personal ones. For an external
managed worktree, discovery uses its own `.cake/workflows` rather than unrelated
ancestors. `workflows.save` saves the frozen program, not a later-edited source
file. Save refuses symlink targets and existing destination files; project save
also refuses symlink `.cake`/`workflows` directories.

## Editing scope

Workers currently share the owning session's exact Working Directory. Separate
contexts are **not isolated files**. Group related changes and avoid overlapping
parallel edits. Workflow-specific managed-worktree isolation and automatic versus
reviewed landing remain unresolved product policy; this implementation does not
claim or add either. Session Families and existing managed-worktree controls remain
separate workflows.

Active workflow runs prevent their owning session from being resolved and their
Working Directory from being discarded or retired. Spawned-task result handoff
waits for the initiating turn to end and its workflows' final reports. Runs record
only assignments executing in the calling Project Session at launch; queued or
unrelated assignments are never settled by a workflow. External launches (Cake
Chat or RPC) do not claim an assignment already executing in the target session.
Multiple runs from one assignment contribute to one consolidated assignment report.

## Verification

In-process tests use real domain policy, resource ownership and projections with
controlled external workers/storage/sandbox boundaries. The integration suite
uses real QuickJS threads to test the host bridge, capability isolation and
cancellation. Compiled Electron/Node sandbox packaging and hidden Electron workflow
composer/details and slash-command checks have passed. Regression coverage includes
cold-owner reacquisition, retry without rerunning workers, assignment correlation,
multiple runs, transient activity ordering and delayed inspection. Full feature
verification and review remain required before landing.
