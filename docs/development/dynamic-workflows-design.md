# Dynamic workflows — contract review r1

Status: **r1 approved; implementation in progress**. The user approved the frozen
[cake contract r1](cake://artifact/dynamic-workflows-contract-r1@r1) and requested
implementation. Runtime, worker and UI slices are being integrated; do not read
this original review-stage inventory as final verification. The immutable r1
artifact preserves the actual reviewed skeleton. The user accepted A1 and requested
fixes following implementation review: transient worker activity, cold-owner final
report delivery and originating-assignment correlation. Live behavior is documented in
[dynamic workflows](./dynamic-workflows.md). Suggested execution now uses
`workflows.propose`, a blocking interactive choice on the existing renderer UI
request lifecycle. It freezes source/metadata/args before display and invokes
ordinary Project-owned background execution only after Run workflow. Explicit
user requests still use `workflows.start` without redundant confirmation.

Repository baseline: `cc06dd6ccbe293d49c45075e0254639dad63ec32`.

## Agreed product decisions

- Dynamic workflows require the application-wide **Settings → Experimental → Dynamic
  workflows** opt-in, off by default. Disabled means no advertised workflow operations,
  proposals, new runs, relaunches, or execution-choice dialogs. Disabling cancels pending
  choices without cancelling already accepted work or removing its existing controls.
- Use the standalone `@earendil-works/pi-codemode` QuickJS/worker sandbox, not the
  ordinary Pi session codemode tool. Pi remains the agent and transcript engine.
- A backend-owned workflow run is associated with a Project Session. It survives
  the initiating turn and renderer observation. It is not another chat/session kind.
- Cake Chat coordinates Project-owned runs; it never becomes their sandbox owner.
- Workers are ephemeral SubagentSession runtimes, with relevant project context,
  common instructions and individual assignments. Their answers go to the script.
  Their Pi transcripts remain available for inspection after runtime release.
- Ordinary subagents and full Session Family children keep their existing behavior.
- Use Claude Code's documented workflow semantics where possible. Do not invent a
  read-only restriction or turn the feature into another permission system.
- The conversation offers workflow execution when appropriate. An explicit request
  already makes that choice. There are no further routine script/phase/worker approvals.
- Progress is a conversation card; Details opens an optional side panel. No separate
  chat mode, automatic array of worker chats, or mandatory visual workflow editor.
- Pause holds new worker admission; active workers finish and checkpoint. Resume
  opens scheduling again. Stop cancels queued work and requests active cancellation;
  it becomes stopped only after cleanup. None of these operations undo file changes.
- I own architecture, core runtime, integration, review, fixes and final verification.
  Two full child Project Sessions may implement bounded worker and UI slices after
  this actual diff is approved. No recursive or follow-up fix/reviewer delegation.

## Prior-art baseline

Sources fetched after consulting the documentation index:

- <https://code.claude.com/docs/llms.txt>
- <https://code.claude.com/docs/en/workflows.md>
- <https://code.claude.com/docs/en/env-vars.md>

The supplied and fetched documentation describes:

- Plain JavaScript orchestration with `agent`, `pipeline`, `parallel`, `phase`,
  `log`, and structured `args`. Workers perform filesystem/shell operations;
  the script has no direct filesystem, shell, network or module-loading capability.
- Literal metadata, frozen run source, saved project/personal scripts and parameters.
- Structured output validation: reject invalid/provably contradictory schemas before
  a worker starts, then allow five answer-validation attempts before failure.
- Six worker attempts maximum for stall/manual restarts. The documented default
  stall window is 600,000 ms, excluding time waiting on tools. Preserve editing
  side effects and accumulated usage; a retry is not a rollback.
- Default per-run concurrency up to 16, reduced on CPU-limited hosts; configurable
  from 1 to 256. Reject helper lists longer than 4,096 and cap a run at 1,000 steps.
- Batch failures retain `null` result slots; a directly awaited exhausted stalled
  worker ends the run. Never silently filter away failed workload items.
- Replay by start order, not a suspended VM snapshot. Reuse a matching successful
  prefix only. The first changed or failed call and all later calls run again,
  even completed later siblings. Effective assignment/schema/model/directory must
  match before reusing a result. Disable clock/random sources in the script;
  callers can explicitly provide a timestamp through `args`.
- No mid-run human-input protocol; user decisions between stages use separate runs.
- Advisory large-run warning (more than 25 workers or projected 1.5M tokens),
  usage visibility and manual controls. No claim of guaranteed savings or correctness.

Cake's Pause semantics are an explicit user-approved choice where the public
prior-art docs do not fully specify treatment of active workers.

Claude-specific permissions, subscription reset waiting, ultracode effort settings,
plugin packaging, model substitution and prompt-cache prefix staggering are not
copied blindly into Pi. Missing provider support must remain visible, not become a
claim of feature parity. A new worker/runtime path must not enable silent model fallback.

## Concrete boundaries in the review diff

| File                                           | Responsibility                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `src/contracts/workflows/workflow-data.ts`     | Validated run, step, program, control and projection data; typed errors   |
| `src/services/pi/WorkflowSandbox.ts`           | Standalone sandbox boundary with only injected orchestration capabilities |
| `src/services/pi/WorkflowWorkers.ts`           | Pi worker turn/inspection boundary, private references, result validation |
| `src/services/pi/WorkflowScripts.ts`           | Read/parse/save/discover script files without host evaluation             |
| `src/services/storage/WorkflowRunStorage.ts`   | Versioned replay checkpoint and atomic revision-checked persistence       |
| `src/services/workflows/WorkflowSupervisor.ts` | Process-scoped resource ownership, not domain policy                      |
| `src/domain/workflows/workflows.ts`            | Named product operations with explicit unimplemented stubs                |
| `src/ipc/protocol/DynamicWorkflowRpc.ts`       | Proposed schema-validated commands and observations; not registered       |

`DynamicWorkflowRpc` is intentionally distinct from the existing
`ProjectWorkflowRpc`, which manages session labels and columns.

The script reads like this (authoring reference, not an executable host program):

```javascript
export const meta = {
  name: "audit-auth",
  description: "Review route authentication and independently verify findings",
  phases: ["Discover", "Review", "Verify", "Report"],
};

await phase("Discover");
const inventory = await agent("List API route groups in the requested scope.", {
  schema: {
    type: "object",
    required: ["groups"],
    properties: { groups: { type: "array", items: { type: "string" } } },
    additionalProperties: false,
  },
});

await phase("Review");
const reviews = await pipeline(inventory.groups, (group) =>
  agent(`Audit authentication in ${group}. Return supported findings.`, { label: group }),
);

await phase("Verify");
const verified = await pipeline(reviews, (review) =>
  review === null ? null : agent(`Independently verify this review: ${JSON.stringify(review)}`),
);

await phase("Report");
return await agent(`Produce a report, including incomplete coverage: ${JSON.stringify(verified)}`);
```

The sandbox prelude provides `agent(prompt, options?)`,
`pipeline(items, callback)`, `parallel(taskCallbacks)`, `phase(title)`, `log(message)`
and the JSON `args` global. Metadata is parsed as syntax, never evaluated on the
host. Helpers run in the VM; admission/checkpoints/worker execution are Cake-owned.

## State, lifetime and concurrency

| Value/resource                                     | Authority and owner                                   | Lifetime/persistence                                              | Concurrency                                                                      |
| -------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Frozen program, step inputs/results and run status | Cake workflow domain + WorkflowRunStorage             | Per-run versioned files under Cake state; atomic checkpoints      | Serialize mutations per run; revision-checked saves                              |
| Pi worker transcript                               | Pi, accessed only through the Pi adapter              | Private subagent-session storage; retained after runtime disposal | One active turn per worker                                                       |
| Sandbox execution and worker attempts              | Backend WorkflowSupervisor scope                      | Live resources only; never persisted as fibers/VM objects         | Keyed Effect FiberMaps; bounded scheduling                                       |
| Scheduling gate                                    | One live run                                          | Transient; persisted status records interruption honestly         | Pause controls admission, not already-running worker turns                       |
| Catalog/detail projections                         | Main-owned domain projection, passive renderer Models | Reconstructed from authoritative snapshots/ordered events         | Snapshot-first observations; detail demand separate from compact cards           |
| Selected detail/step, pending controls and errors  | Focused renderer WorkflowRunStore                     | Window-local, disposed with surface; not business authority       | Typed Client calls; no Effect/transport in ordinary Stores                       |
| Final conversation report                          | Pi parent Conversation                                | Ordinary Pi-owned context/handoff entry                           | Run/assignment-correlated handoff; intermediate worker replies are not delivered |

On backend restart, lost live execution must be shown as interrupted rather than
left running. Deliberate relaunch uses persisted results; it never automatically
starts a new billed run. No separate transcript log is saved by Cake. Stopping a
run doesn't promise to kill every daemon a shell command may have independently
launched; cancellation follows the existing Pi tool/process boundary.

A run must count as active for Project Session resolution, family retirement and
Working Directory deletion. An idle parent Pi turn is not sufficient to retire its
checkout while a workflow is still editing/reading there. Likewise, a spawned task
must not send its automatic task-completion handoff merely because the turn that
launched the workflow ended; the workflow's final handoff must reach Cake Chat or
the family requester as the task result, not be lost behind an early startup report.

Final report delivery has its own interruptible, process-scoped FiberMap so a
transient delivery failure does not rerun workers or hold execution cancellation.
A cold Project Session owner is assembled through the normal domain acquisition
path. Checkpoints retain the initiating assignment IDs; several runs from one
assignment settle together after that turn ends. External launches do not capture
unrelated executing assignments. Live worker activity travels on a transient PubSub
channel with observer-local ordering; unchanged usage does not write checkpoints.

Each relaunch increments an execution number. Worker targets/activity carry that
number so late updates cannot affect replacement attempts. The six-attempt budget
is per execution; prior Pi references and billed usage remain retained. Returning
a cached result on replay does not add its old usage again.

## Planned initial ownership (not assignments yet)

### Parent: core/runtime/integration

- Existing review contract files, new Live sandbox/script/storage/supervisor
  implementations, `src/domain/workflows/`, scheduler/replay tests and sandbox build tests.
- Backend composition, CakePaths, RPC server/client registration and renderer Client
  group additions; lifecycle/retirement guards and final report delivery.
- New Pi workflow operation registry and Project Session/Cake Chat wiring. The
  Project worker-context capability change below belongs to the worker child.
- Frozen authoring reference/skill and saved-command discovery wiring.
- Package/lockfile changes for a direct pinned pi-codemode dependency and any output
  validator; bundled/externalized worker/WASM verification. Dependency installation
  must first replace this worktree's node_modules symlink, never modify main's dependencies.
- Main-owned test fixtures for scheduler, persistence and worker-independent integration.

### Worker child: Pi/SubagentSession adapter

- New `src/services/pi/live/WorkflowWorkersLive.ts` and its focused supporting
  worker code beneath `src/services/pi/runtime/workflows/`.
- `tests/app/services/workflow-workers.test.ts` and related Pi-worker fixtures.
- In `cake-session-runtime.ts`, only the runtime option declaration for auxiliary
  project resources. In `cake-session-runtime-capabilities.ts`, only resource-loader
  selection for workflow workers. Ordinary bounded subagent behavior stays unchanged.
- Implement the approved `WorkflowWorkers` service; do not change its interface,
  shared schema signatures, parent notification implementation or UI code.

The current `auxiliary` flag suppresses skills/extensions/prompts together.
Workflow workers need project context/skills without accidentally receiving Cake
controls, relationship prompts or another conversation engine. This adapter change
is required; calling the existing five-minute `subagents.run` is not the design.

### UI child: progress/detail surface

- New `WorkflowCatalog`, `WorkflowRun`, `WorkflowStep` projection Models (one per file),
  `WorkflowRunStore`, reducer and focused observer integration.
- New progress-card/detail/worker-detail feature components, composed from shared
  `Button`, `IconButton`, `Badge`, `Callout`, `DisclosureTrigger`, `SidePanel` and
  existing code/work-log views. Any genuinely new interaction primitive goes into
  `components/ui` and `docs/development/component-catalog.md`.
- Local wiring in `RootProjection.ts`, `ProjectSessionStore.ts`, Project/Cake Chat
  surfaces, `observers/models.ts` and renderer typed test fixtures; do not modify
  parent-owned transport/server or Pi adapter files.
- `tests/app/renderer/dynamic-workflow.test.tsx`, targeted hidden Electron coverage
  and an existing repository-owned visual-capture scenario.

Models are main-data projections; the Store owns selected details and control
request policy. Every chat remains the existing Chat + ChatStore. No raw interactive
HTML in feature TSX, stylesheet additions, parallel chat implementation or new
renderer runtime. Observation wiring stays in renderer infrastructure.

Mechanical caller/fixture expansions are allowed and reported once, but shared
contract changes and ownership conflicts require coordination. I do the final
integration, review, fixes and verification directly.

## Keep / add / change / exclude

- **Keep:** Pi loops, profiles and transcripts; ordinary subagent APIs/notifications;
  Session Families; managed-worktree lifecycle; shared Chat; existing RPC transport.
- **Add:** workflow contracts, sandbox host, scheduler/journal, workflow-owned worker
  adapter, saved scripts, compact projections, progress/detail UI and tests.
- **Change:** narrow resource configuration, parent completion handoff, backend and
  client composition, activity guards and existing surface wiring.
- **Exclude:** another session engine, host execution of generated JS, automatic
  permissions, global Cake Chat sandbox ownership, silent model substitution,
  infinite worker retry loops and new compatibility facades.

### Unresolved editing policy — do not infer approval

Editing is not prohibited, but parallel checkout isolation and **automatic landing
versus leaving successful changes isolated for review** still need a decision.
The conversation recommended isolated managed worktrees and serialized automatic
landing; the user did not approve that recommendation. This review skeleton does
not implement or authorize it. Existing managed-worktree machinery is the starting
point, not raw git-worktree commands or a new merge engine. Editing-isolation/landing
work must stay outside initial child assignments until this is settled.

## Acceptance and verification

The actual named TODO cases are in:

- `tests/app/domain/dynamic-workflows.test.ts`
- `tests/app/services/workflow-workers.test.ts`
- `tests/app/services/workflow-scripts.test.ts`
- `tests/app/renderer/dynamic-workflow.test.tsx`
- `tests/integration/workflow-sandbox.test.ts`

Implementation tests retain real domain policy/projections/Stores and fake only
external boundaries. Use Deferred/Queue/Latch/Ref for scheduling and cancellation,
not sleeps or real paid models. Real worker threads, Pi integration and compiled
asset resolution belong in the integration suite. UI focus/typing/portals require
hidden Electron tests after a final build, not a localhost browser or jsdom claim.

Investigation probe: the installed standalone sandbox successfully executed two
injected `agent` calls with JSON arguments/results and cancellation signals;
`process` and `require` were absent inside the VM. This was a narrow Node probe,
not a workflow runtime or Electron-packaging test. Electron main externalizes
installed dependencies and the standalone server build also uses external packages;
compiled-host verification is still required before claiming packaging works.

### Review-stage verification

- `pnpm format` and `pnpm format:check`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint:oxlint`: passed; repository-wide ESLint also passed.
- `pnpm lint`: **not fully passed**. Knip reports exactly the eight deliberately
  unregistered skeleton source files as unused. Do not suppress this or register
  unimplemented operations just to make the review skeleton pass; wiring during
  implementation must remove these findings before final acceptance.
- Focused test invocation: 16 existing subagent tests passed; 59 new in-process
  acceptance cases remain skipped TODOs. The eight real-sandbox integration cases
  also remain TODOs and were not run as implementation verification.
- No application build, Electron smoke or visual capture is claimed at this stage.

Skipped TODOs are not acceptance passes. No child implementation or production
cutover occurs before approval of this diff. The immutable review artifact records
this r1 baseline; later contract amendments require renewed approval, while
mechanical expansions are reported at completion.
