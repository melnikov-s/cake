---
name: sol-luna-orchestration
description: Token-efficient Sol orchestration using Luna Max subagents. Use when the user explicitly requests delegation, outsourcing, subagents, or the Sol/Luna workflow.
disable-model-invocation: true
---

# Sol → Luna Max

Optimize premium Sol tokens only after preserving scope control and reviewability. Sol owns decomposition, sequencing, architecture, risk, and integration. Luna owns bounded execution and evidence within one selected slice. Never transfer an umbrella initiative to Luna, and never duplicate Luna's completed mechanical work with a full Sol re-review.

Exact Luna task settings:

```json
{
  "model": {
    "prefer": "exact",
    "provider": "openai-codex",
    "modelId": "gpt-5.6-luna",
    "thinkingLevel": "max"
  },
  "fastMode": true
}
```

Name the configuration `openai-codex/gpt-5.6-luna /max` with Fast mode. Use `retain: false` for ordinary one-shot work. Set `retain: true` only when intentional follow-up with the same runtime is part of the plan.

## Mandatory decomposition

For any broad, repository-wide, multi-surface, or multi-stage goal, Sol must first decompose the work into an ordered sequence of coherent, independently reviewable slices. Delegate only the next slice, not the umbrella objective.

A bounded Luna task must name one behavior, one component family, one migration surface, or another comparably cohesive unit. It must include an explicit objective, narrow allowed scope, constraints, acceptance checks, and escalation conditions. A long prompt does not make a task bounded. An allowed scope such as `src/**`, `src/renderer/**`, or “the whole codebase” is not bounded unless the requested operation is itself a narrow mechanical transformation with unambiguous automated verification.

Do not give Luna responsibility to audit an entire initiative, choose its priorities, implement all resulting work, and validate the whole result. Audit and planning may be delegated as their own read-only slice, but the returned plan remains subject to Sol's sequencing decision.

When the user asks to give Luna “all the grunt work” or equivalent, interpret that as a sequence of Luna-owned execution slices. It does not authorize one repository-wide delegation.

## Sequential orchestration loop

1. Sol identifies the next smallest coherent slice that produces useful progress.
2. Sol delegates that slice with exact boundaries and acceptance checks.
3. Luna inspects, implements, runs focused checks, and returns a short capsule.
4. Sol reviews the changed-file boundary, automated evidence, decisions, and flagged risks. Do not redo every line or repeat Luna's mechanical investigation.
5. Sol accepts, corrects, or narrows the result, then chooses the next slice.
6. Repeat only while the next slice remains clear and useful.

Narrow does not mean trivial. Do not delegate a single obvious command, a one-line edit, or another task whose coordination overhead exceeds its execution cost. However, “do not delegate microtasks” must never be used to justify delegating an entire initiative.

## Delegation scale

- **0 — Sol only:** trivial, ambiguous, architectural, security-sensitive, or delegation overhead exceeds savings.
- **1 — Luna mechanical slice:** searches, renames, repetitive edits, focused documentation, tests, or one narrow migration. Accept automated evidence.
- **2 — Luna bounded owner (default):** one coherent behavior or surface with explicit boundaries. Luna inspects, implements, tests, and returns a short capsule.
- **3 — Luna workstream:** a large divisible goal executed as separate non-overlapping slices. Sol defines and sequences the boundaries. Use parallel agents only when the user explicitly requests parallel agent work.
- **4 — Sol takeover:** use after Luna reports an architectural conflict, unresolved ambiguity, untestable risk, or a bounded failed attempt.

## Return capsule

Require only: outcome, files changed, decisions, checks/results, uncertainty, and exact hotspots for Sol. Run automated gates first. Sol reviews boundaries and flagged risk—not every line. Do not send full transcripts, delegate trivial commands, or let Sol pre-solve work Luna will repeat.
