# Idle family message queue: root cause and implementation handoff

## Scope and confidence

This document records the root-cause investigation performed at checkout `8cfc8ad` (`agent/analyze-stuck-queue-f865e9`), including the recent fix `8cfc8ad62e30ed21f5dc3846eee085384cf7ee6f`, the screenshot's exact child/parent transcripts, and installed Pi 0.84.0 code.

The confirmed delivery defect was subsequently repaired in this branch at the shared Pi runtime boundary. Cake now calls Pi's `prompt(..., { streamingBehavior })` operation, which starts an idle recipient and preserves follow-up or steering queue semantics for an active recipient. The regression test uses ordinary follow-up text and confirms that an idle runtime invokes the provider and leaves no queued message. The separate queue-action capability issue remains documented analysis and is not part of that delivery repair.

**Confirmed delivery defect:** an explicit `delivery: "queue"` becomes a raw Pi follow-up insertion even when the destination is idle. Pi does not start a run for that insertion. The message remains visibly queued, with no consumer.

**Confirmed action defect:** runtime-projected queue entries have `editable: false`, and the component uses that flag to hide _all_ queued-row actions, including Send now. The screenshot does not establish text overflow as the reason the buttons are missing. Text truncation and nonshrinking action layout already exist.

No real Electron reproduction or application test suite was run. This checkout has no `node_modules`. The narrow Pi-core reproduction below used the installed dependency read-only, not application files from the main checkout. The exact running Electron build was not fingerprinted.

## Evidence from the reported incident

The exact visible text was found in the child transcript:

- Child: `d4a93c70-0541-4547-9418-6c9f8a3e929f` (Review CakeRuntime recovery and resources).
- Parent: `01a082da-62cc-7d64-a9ac-e7c43a7d50e4`.
- Parent's last assistant message before this delivery: **2026-09-09T19:19:29.498Z**, `stopReason: "stop"`. It says the independent review was started.
- Child's send: **2026-09-09T19:23:21.444Z**, almost four minutes later.

Actual tool arguments, shortened only in the message body:

```json
{
  "command": "sessions.send",
  "input": {
    "sessionId": "01a082da-62cc-7d64-a9ac-e7c43a7d50e4",
    "text": "Independent review of 055d663 complete: no concrete regressions found and no fix commit created. ...",
    "delivery": "queue"
  }
}
```

The tool returned at **19:23:21.464Z**:

```json
{
  "ok": true,
  "messageId": "04824131-9153-4271-ac21-dcb41fa86688",
  "threadId": "acd58302-fd47-4d35-81a6-7a78f08742e0",
  "turnId": "84b8a722-71ac-4a1e-bba6-c1b8fc44b16e",
  "delivery": "queue",
  "status": "queued"
}
```

No later parent message appears in the inspected 19:19–19:27 interval. This and the screenshot strongly support an already-idle destination, rather than requiring a timing race. Transcript stop records are not a direct runtime-state trace, but the explicit-queue failure does not depend on guessing renderer state.

Evidence files, outside the repository, inspected read-only:

- `/Users/user/.cake/pi/sessions/--Users-user-dev-.cake-worktrees-electron-architecture-analysis-and-simplificatio-1e5ec6--/2026-09-09T19-19-25-645Z_d4a93c70-0541-4547-9418-6c9f8a3e929f.jsonl`
- `/Users/user/.cake/pi/sessions/--Users-user-dev-.cake-worktrees-electron-architecture-analysis-and-simplificatio-1e5ec6--/2026-09-08T21-09-05-356Z_01a082da-62cc-7d64-a9ac-e7c43a7d50e4.jsonl`

## Failure chain

Line references below are for this investigation checkout; use symbol names after rebasing.

1. **Routing selects a queue operation without an idle override.** `src/layers/ProjectSessionEnvironmentLive.ts:368–376` computes:

   ```ts
   const delivery = input.delivery ?? (destinationSnapshot.streaming ? "queue" : "prompt");
   ```

   Explicit `"queue"` bypasses the idle default. It calls `destination.followUp(encoded, [], false)`.

2. **Acceptance is asynchronous, not proof of execution.** `src/services/pi/PiSessions.ts:484–553`, `startTurn`, allocates an input/turn ID, retains a runtime lease, records an active turn, publishes `turn-accepted`, and forks `runtime.prompt(...)`. The caller gets a turn ID before execution completes. The family route reports `"queued"` from the requested delivery mode; it does not verify consumption.

3. **The runtime passes follow-ups directly to Pi.** `src/services/pi/runtime/cake-runtime.ts:2666–2670` unconditionally calls `session.followUp(content, images)` for `delivery === "follow-up"`. The neighboring prompt and steer paths have idle-start behavior; the follow-up path does not.

4. **Pi correctly implements a queue primitive, not a wakeup primitive.** Installed `pi-coding-agent/dist/core/agent-session.js:1003–1044`, `followUp` / `_queueFollowUp`, records the pending text, emits `queue_update`, and calls `agent.followUp`. Installed `pi-agent-core/dist/agent.js:177`, `followUp`, only enqueues. It neither calls prompt nor starts an agent loop.

5. **Cake faithfully renders pending input.** `session-projection.ts:524–562`, `projectQueuedMessages`, creates a queued user part and extracts the cross-session message body/attribution. `ProjectSessionStore.runtimeQueuedPrompts` exposes it above the composer. Pi stays nonstreaming, so the idle composer and queued row can truthfully coexist.

6. **There is no consumer to settle this accepted input.** `RuntimeTurnCompletion.consume` waits for the user message to be consumed, and `settle` resolves only consumed inputs. The runtime awaits that completion. This is a stranded input/run lease, not evidence of a blocked model request or mutex deadlock. The renderer's `PromptQueueStore.drain` owns only its local editable `prompts`; it cannot drain this Pi-owned remote queue.

The family missing-reply worker is not a rescue mechanism: accepted replies are marked reported, and queued messages/live delivery IDs prevent duplicate fallback notices. Do not change settlement to mean “queue insertion succeeded”; that would conceal the missing execution and break turn correlation.

### Small dependency-level reproduction

Using installed Pi core with a stream function that throws if invoked:

```js
const agent = new Agent({
  streamFn: () => {
    throw new Error("Unexpected provider call");
  },
});
let events = 0;
agent.subscribe(() => events++);
agent.followUp({
  role: "user",
  content: [{ type: "text", text: "Idle follow-up reproduction" }],
  timestamp: Date.now(),
});
await Promise.resolve();
```

Observed: `isStreaming=false`, `hasQueuedMessages=true`, `messages.length=0`, `events=0`. No provider call. This verifies the Pi primitive; it is not a full Cake integration regression test.

## Why the recent fix misses this

`8cfc8ad` (Fix idle session steering deadlock) adds an idle `session.prompt` fallback only for `delivery === "steer"`. It leaves the unconditional follow-up branch in place. The reported message explicitly requested `queue`, not steer, so it never enters the repaired branch.

The added runtime regression, `starts an idle session when steering delivery arrives` in `tests/app/agent/pi-runtime.test.ts`, sends `/idle-steer`, an extension command. It proves command dispatch through `prompt`, but does not exercise ordinary cross-session text, follow-up delivery, actual agent startup, consumption, or turn settlement. A passing test does not cover this incident.

**Branch caution:** the incident's review commit `055d663` is not descended from `8cfc8ad` (`git merge-base --is-ancestor 8cfc8ad 055d663` returns 1). At `055d663` the equivalent code is in:

- `src/domain/projectSessionRuntime.ts`, family-message routing around lines 326–331.
- `src/services/pi/runtime/cake-runtime-turn-controller.ts`, `prompt`, follow-up dispatch around line 230.

That version directly queues both steer and follow-up. This does not prove which source built the running Electron process, but it means the reviewed worktree cannot be assumed to include the previous fix. **Even with `8cfc8ad` installed, the explicit-queue defect remains.** Apply the eventual repair to the owner in the destination branch; do not reintroduce old monolithic code after the extraction.

## Other ways the same boundary can strand input

- Omitted delivery: routing sees `snapshot.streaming=true` and selects queue; the destination settles before the forked runtime delivery executes. The unconditional follow-up branch can then enqueue into an idle runtime. This is a code-level race exposure, not needed to explain the observed incident.
- `cancelSteering` in `cake-runtime.ts:2738` clears queues and re-adds their text via `session.followUp`, with no idle-start check. Review the intended demotion behavior when the run settles concurrently. This is secondary, not evidence the user canceled this message.
- `flushCompactionQueue` has separate direct queue calls. Audit multi-item delivery after an awaited first prompt and ensure an idle session is not left with later items queued. Treat this as a related test case, not the established cause here.

## Queue actions: distinguish rendering policy from layout

`src/renderer/components/queued-prompts.tsx` already uses:

- Text container: `min-w-0 flex-1`.
- Text: `min-w-0 flex-1 truncate`.
- Actions container: `shrink-0`.

For a runtime-projected message, `ProjectSessionStore.ts:125` always sets `editable: false`. All three queued-state buttons are gated on `entry.editable !== false`, including **Send now as steering**. Consequently this screenshot's remote queued message renders an empty actions container regardless of text length. The steering-state cancel button is a separate branch.

Simply adding truncation classes cannot expose nonexistent controls. Simply deleting the guards is also wrong: `ConversationSessionStore` wires action callbacks to `PromptQueueStore`, whose `take(id)` searches only local prompts. A remote part ID will not be found; the apparently fixed button would do nothing.

Recommended implementation:

1. Separate capabilities such as editability and ability to send now. A remote message may be noneditable but still need a working resume/send-now action.
2. Implement authoritative runtime/domain behavior for whichever remote actions are exposed; preserve cross-session metadata and completion correlation. Do not implement “send now” by resending visible text while leaving the original Pi queue entry behind. That risks duplicate delivery and loses metadata.
3. The existing queue APIs are whole-queue operations, and projected part IDs are not Pi queue-item handles. Choose deliberately between a clearly labeled whole-queue resume capability and stable per-item runtime identity/operations. Do not make a per-row action silently clear unrelated messages.
4. Preserve full message content; truncate only its visual presentation. If a separate local-row overflow reproduces, measure the row and every flex/grid ancestor in Electron and apply `min-w-0`/width constraints at the actual failing boundary. No layout overflow was independently established in this analysis.

## Recommended repair boundary and invariants

Define `queue` as **do not interrupt current work; execute when idle**, not “wait indefinitely for some unrelated future prompt.” That matches the user's expectation. If a deliberately paused queue is ever wanted, it needs a distinct explicit product policy, not accidental use of Pi's low-level queue primitive.

The delivery decision must be finalized at the main-process Pi runtime boundary against current runtime state, not solely against a caller's snapshot. Prefer the smallest shared delivery helper covering prompt/steer/follow-up and existing compaction paths:

- Idle and not compacting: accepted ordinary input starts a normal Pi turn, including follow-up intent.
- Running: follow-up queues behind work; steer preserves steering semantics.
- Compacting: retain existing deferred-input behavior and resume after compaction.
- Concurrent start/settle: re-evaluate or use Pi's supported delivery semantics so input is neither rejected spuriously, duplicated, nor stranded. Inspect `session.prompt`'s supported streaming behavior before inventing locks or a second scheduler.
- Preserve input identity, encoded cross-session content, attachments, presentation flags, response retries, abort behavior, and consumed-then-settled completion tracking. If idle follow-up now uses prompt input transformations, review the `mayTransform` argument to `RuntimeTurnCompletion.track` too.

Do not fix this only in the family router: that misses other follow-up callers and the snapshot-to-dispatch race. Do not add a renderer polling drain or require the destination to be selected/open. Pi remains queue/transcript authority; Cake owns routing and wakeup policy.

Repairing future insertions will not automatically consume an already-stranded in-memory entry. Specify a safe resume behavior for existing pending input without asking the user to resend and create a duplicate. Do not clear queues or restart the live application as an investigative step; this analysis has not established persistence/recovery guarantees for those pending messages.

## Required regression coverage

### Runtime owner (lowest causal layer)

Use ordinary text and a deterministic fake provider/session boundary that retains real runtime dispatch and completion tracking. Assert transitions, not just the return from queue insertion.

1. **Idle + explicit follow-up:** starts a run; consumes the message exactly once; removes queued projection; completes its accepted turn only after the run settles.
2. **Active + follow-up:** does not interrupt; consumes after existing work; completes both relevant input correlations correctly.
3. **Active snapshot, idle at dispatch:** use barriers/Deferred, not sleeps; recipient still starts and consumes.
4. **Idle check, concurrent start:** preserves follow-up/steering intent without duplicate input or an unhandled already-processing error.
5. **Idle + steer:** ordinary message, not only a slash command.
6. **Compaction with multiple pending messages:** every message eventually consumed once, none stranded after the first resumed turn.
7. **Abort/cancel:** no resurrection after explicit abort, no falsely completed unconsumed input, no disappearing or duplicated demoted messages.

### Family workflow integration

Retain the actual family route, PiSessions admission, runtime dispatch, and renderer projection; fake only external boundaries. Start an idle parent; send the child's encoded reply with explicit `delivery: "queue"` (the exact triggering case). Assert parent execution, attribution, consumption, eventual settlement, and no spurious missing-reply notice. Also cover an active parent and the stale-snapshot transition. Keep the test independent of renderer visibility.

Existing starting points: `tests/app/domain/sessionFamilyDelivery.test.ts`, `tests/app/agent/pi-runtime.test.ts`; on the refactored branch, also inspect its turn-controller tests. Existing notice-delivery tests are not sufficient proof of explicit child-message dispatch.

### Electron UI

Use the real ProjectSessionStore projection path for a remote follow-up and separately a local editable entry. Test long prose, an unbroken long token, and a narrow composer. For every supported action assert that it exists, its bounding box stays inside the row/composer, it receives a real click, and the authoritative queue operation produces the expected transition. Verify full text is retained. Include queued and steering states.

Build the isolated Electron fixture after final source changes. Do not treat jsdom layout assertions as proof. Run focused tests, relevant typecheck, Oxfmt, and Oxlint; no need for the entire e2e suite.

## Acceptance checklist

- An explicit queued child reply wakes an idle parent with no manual input.
- Active parent work is not interrupted by ordinary queued replies.
- Accepted input is consumed exactly once and settled truthfully.
- Remote queue rows offer the intended working recovery action; no fake local-only callbacks.
- Supported controls remain visible/clickable with long text and narrow width.
- The fix is verified in the branch/build actually used by Electron, including the refactored controller if applicable.
