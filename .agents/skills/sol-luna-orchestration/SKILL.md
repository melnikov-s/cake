---
name: sol-luna-orchestration
description: Token-efficient Sol orchestration using Luna Max subagents. Use when the user explicitly requests delegation, outsourcing, subagents, or the Sol/Luna workflow.
disable-model-invocation: true
---

# Sol → Luna Max

Optimize premium Sol tokens, not delegation count. Sol owns scope, architecture, risk, and integration; Luna owns bounded execution and evidence. Never duplicate Luna's work with a full Sol re-review.

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

Name the configuration `openai-codex/gpt-5.6-luna /max` with Fast mode.

## Delegation scale

- **0 — Sol only:** tiny, ambiguous, architectural, security-sensitive, or delegation overhead exceeds savings.
- **1 — Luna mechanical:** searches, renames, repetitive edits, docs, tests. Accept automated evidence.
- **2 — Luna bounded owner (default):** give objective, allowed scope, constraints, acceptance checks, and escalation conditions. Luna inspects, implements, tests, and returns a short capsule.
- **3 — Luna workstream:** for large divisible work, delegate independent slices; Sol defines boundaries and integrates. Avoid overlapping agents.
- **4 — Sol takeover:** only after Luna reports an architectural conflict, unresolved ambiguity, untestable risk, or a bounded failed attempt.

## Return capsule

Require only: outcome, files changed, decisions, checks/results, uncertainty, and exact hotspots for Sol. Run automated gates first. Sol reviews boundaries and flagged risk—not every line. Do not send full transcripts, delegate microtasks, or let Sol pre-solve work Luna will repeat.
