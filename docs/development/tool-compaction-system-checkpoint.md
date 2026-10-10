# Tool Compact and system-message pills

## Finding

The confirmed Project Session bug was a **real redundant canonical system declaration**, not merely a synthetic pill. Cake's Tool Compact replay policy discarded all `role: "system"` entries. Pi 1.0 uses those entries as its structured prompt/tool baseline, so the next prompt compared current instructions with an empty baseline and persisted the entire unchanged system declaration again. Cake correctly projected that new Pi event as “System message”, but it should never have been necessary.

A concrete read-only JSONL inspection found this exact case in Project Session `6a1b7724-08a4-4cc3-80f9-cff0c447776b`: Tool Compact marker `bad9a6b7` at `2026-10-10T16:37:05.558Z`, followed by system entry `29df2ba0` at `16:37:05.619Z`. Every prompt section and tool declaration matched the folded source baseline. A later system entry `3c8b9e36` changed only `project_context`: that genuine change must remain represented. Two other recent fork/compaction examples also re-declared the full baseline, but changed Working Directories and instructions, so they are not evidence of wholly redundant instructions.

The earlier resolved mode-reminder session landed commit `f58c37c0`, which is an ancestor of this checkout. The landed controller infers text/voice/presentation transitions from Pi history and queues. Tool Compact strips those injected reminders; it did not preserve Pi's canonical system baseline. Mode reminders and canonical instructions are different contracts.

## Paths through the system

- `src/services/pi/runtime/session-tool-compaction.ts`: clean branch replay. Carry one folded canonical system checkpoint from the **selected** source branch, including Pi's normal compaction checkpoints; then append the non-context marker, dialogue, provenance and configuration. No custom/reminder messages are retained.
- `src/services/pi/runtime/cake-session-runtime-continuations.ts`: Tool Compact navigates the live Pi session to that branch and emits a snapshot. It does not prompt the model or inject reminders itself.
- Pinned Pi `dist/core/agent-session.js`: `_preparePromptAndToolLoadout` diffs prompt sections against `getCurrentSystemMessage`; `prompt` prepends a system patch only when sections change. Tool declaration changes are handled by Pi's loadout preparation. `navigateTree` refreshes finalized context and restores tools from the canonical transcript.
- Pinned Pi `dist/core/session-manager.js`: `appendCompaction` stores a folded `systemMessage` checkpoint; `buildSessionProjection` places it before the summary and omits earlier retained system deltas. Manual `compact` and automatic threshold/overflow paths both use that operation. Normal compaction alone does not append a separate duplicate system-message entry.
- Pi request preparation/AI transcript resolution keeps the leading canonical prompt/tools available in subsequent API requests. `before_agent_start` overrides may replace the request's leading prompt without becoming custom messages. This fix does not alter request transforms or remove required instructions.
- `src/services/pi/runtime/session-projection.ts` and `tool-compaction-provenance.ts`: the Tool Compact marker identifies the exact carried checkpoint entry. Only that system entry is omitted from the injection timeline, including in forks inside replayed dialogue that precede full provenance. Unmarked system/custom events are not hidden.
- `src/services/pi/runtime/conversation-display-projection.ts`: display history reconstructs original work and reminders using provenance. Historical system events remain inspectable; actual post-compaction system patches remain current context pills. Fork-prefix reconstruction follows the same checkpoint rule.
- `src/services/pi/runtime/cake-session-runtime-snapshot.ts` and `cake-session-runtime-event-projection.ts`: `runtime-system-prompt` is a synthetic, stable-ID view of the live effective prompt, placed at the start of snapshots and updated on `agent_start`. It is intentionally available for inspection, not a canonical transcript event or new injection. Renderer `SessionPartReducer` updates it in place.
- `src/services/pi/runtime/session-projection.ts`: actual Pi system/custom messages become context parts in live and settled projections. `chat-transcript-items.ts`, `chat-transcript-part.tsx`, and shared `ui/context-pill.tsx` group and disclose them.

## Cake Chat is a different runtime

Current Cake Chat uses `src/services/pi-durable/durable-chat-runtime.ts`, not `createCakeSessionRuntime` (which rejects `globalControl`). Tool Compact/tree navigation are unsupported. Manual compact delegates to Durable's compaction task; automatic compaction follows Durable's policy. `durable-chat-engine.ts` preserves the canonical system in bounded reset heads and sends the committed active context. Memory indexing excludes system declarations.

`durable-chat-history.ts` projects only original user/assistant/tool-result entries and excludes system messages and reset/compaction entries. Therefore the Project Session redundant-pill path does not apply to current Cake Chat. Durable's `dist/harness/prompt.js` deliberately writes a fresh `pi.system` baseline after any head marker, even when its values match. Cake's ordinary per-run resets already trigger that behavior without compaction; the request-boundary reset folds it into one canonical system message in the actual request. A compact task alone does not append a `pi.system` declaration.

Cake Chat's existing original-only projection also does not disclose genuine `pi.system` changes or a live system-prompt pill; that is a separate instruction-visibility gap, not addressed by suppressing more context here. The regression verifies instructions survive compact, ordinary continuations establish canonical checkpoints with or without compact, API requests contain one system message, and later configuration changes are still persisted and sent. Changing Durable's checkpoint policy would require a separate SDK-boundary design, not treating checkpoints as reminders.

## Regression coverage

- `tests/app/agent/session-tool-compaction.test.ts`: canonical instructions retained; multimodal reminders/custom context removed; folded section/tool changes and normal checkpoint honored; selected earlier branch isolated from later instructions; repeated compaction does not accumulate system pills; genuine later changes remain visible.
- `tests/app/agent/session-discovery.test.ts`: a fork inside replayed dialogue retains the canonical checkpoint without adding a new injection pill.
- `tests/integration/cake-session-runtime-characterization.test.ts`: real Pi runtime and deterministic local provider verify unchanged system content in subsequent API requests, no live/settled duplicate injection after Tool Compact, manual and automatic compaction, and a visible genuine instruction change after resource reload.
- `tests/electron/tool-compacted-work-log.smoke.spec.ts`: real hidden Electron preview rendering distinguishes historical instructions, a carried checkpoint and genuine new instructions (the preview has no live runtime prompt).
- `tests/app/services/pi-durable/cake-chat-durable.test.ts`: current Cake Chat manual-compaction/request/persistence characterization.

No session files are migrated or rewritten. Older redundant declarations remain historical evidence. No merge/landing is implied by this change.
