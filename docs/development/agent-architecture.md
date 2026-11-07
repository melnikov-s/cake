## What Cake is

Cake is Pi expressed as a desktop GUI. Pi remains the coding-agent engine; Cake
does not reimplement its agent loop, providers, tools, extensions, skills,
compaction, or session format. Cake makes Pi's work navigable across projects
and sessions and uses the web platform for interactions that a terminal cannot
express well: rich transcripts, diffs, artifacts, forms, diagrams, and media.

Cake is also a layer above any one Pi Session. It presents the user's
collection of Projects and Cake Sessions, lets them move among and compare
those sessions, and provides application-level workflows such as Cake Chat. A
Cake Chat Session is a Pi-backed meta-session for reasoning about and navigating
Cake as a whole; it is not a replacement transcript authority for Project
Sessions.

The conversation remains primary. Rich surfaces should appear because they help
the current work, not because Cake is trying to become a general-purpose IDE.

See `docs/architecture/cake-architecture.md` for the process, authority, trust,
state, and development boundaries behind these principles. The documentation map
in `docs/architecture/README.md` distinguishes maintained contracts from task-specific
artifacts and explains their documentation responsibilities.

## Architecture and library guidance

Consult documentation proportionally while investigating and implementing; do
not treat exhaustive reading as a prerequisite to making the first focused
code change.

- For architecture or feature-ownership changes, consult the relevant sections
  of `docs/architecture/cake-architecture.md`,
  `docs/architecture/cake-vocabulary.md`, and
  `docs/architecture/effect-architecture.md` before finalizing the design.
- For renderer-state or chat changes, read the authoritative
  [renderer state ownership](../architecture/cake-architecture.md#renderer-state-ownership)
  and [conversation invariants](../architecture/cake-architecture.md#conversation-invariants).
  Inspect the existing Models/Stores and relevant r-state-tree `README.md`, skill,
  or API references. Keep these contracts in the architecture doc, not duplicated here.
- For Effect code, use `.agents/skills/effect-ts/SKILL.md`, the installed
  `node_modules/effect/AGENTS.md`, and their relevant linked references as
  targeted guidance. Cake architecture decides ownership and process boundaries;
  the installed Effect package is the API authority; the local skill defines
  Cake's Effect coding conventions within those boundaries.
- When guides do not answer a particular Effect API question, inspect the pinned
  implementation in `node_modules/effect/src`.

## System-prompt style

Use the [approved core-workflow preview](cake://session/project-chat%3Ab8b476e4e1a070acad3fc4d543ea5c22e0098187c34347f866cefbf715743f2b?message=41127)
as the golden style example when authoring or reviewing system prompts. It is a
preview, not evidence that its operations or behavior have shipped; current
registered contracts remain authoritative. Apply the style, not a frozen copy of
its APIs.

Review criteria:

- Put the role, essential rules, and everyday controls first. Routine work should
  not require discovery calls to learn basic calling contracts.
- Make instructions obvious, terse, and directly actionable: say what to do, when,
  and with which operation. Prefer short, task-named sections to explanatory prose.
- Show concrete common calls: exact operation names, required arguments, common
  optional arguments, and consequential defaults. Derive signatures from registered
  tool contracts rather than maintaining independent schemas; keep full schemas
  behind help.
- Retain critical semantics and security boundaries even when shortening: authority,
  permissions, identifier/revision handling, lifecycle distinctions, and verification
  of outcomes. Accepted delivery, reported completion, and verified success are
  different facts.
- Treat tokens as a cost. Remove fluff, repetition, redundant examples, and helper
  copy that does not change an action or decision. Brevity must not erase a necessary
  contract or safety rule.
- Progressively disclose specialist capabilities, advanced options, and uncertain
  contracts through focused help. Do not hide ordinary coordination behind repeated
  discovery or make exhaustive documentation reading a prerequisite.

Minimal verbatim excerpt from the approved preview:

```text
REPORTS
messages.read {ref, offset?, maxChars?}
Known report reference: read it directly.
Continue with nextOffset when necessary.
Link the exact original as "Full agent response".
Verify evidence before claiming success.

DISCOVERY
Use <operation>.help only for unfamiliar operations, omitted advanced
options, or contract errors. Keep specialist tools progressively disclosed.
```

For each review, check that an author can identify the next common action and
construct its call from the prompt alone, while still knowing what requires help,
authorization, or outcome verification. Use the full preview for the broader
workflow example; do not copy its entire reference into unrelated prompts.

## Core ownership rules

- Pi owns agent sessions, transcript history, model/provider state, and execution.
  Regular Project Sessions use Pi's coding agent and JSONL history, branching,
  and compaction. Permanent Cake Chat intentionally uses Pi Durable's SDK-owned
  SQLite originals, inbox, checkpoints, and recovery; shared presentation does
  not imply identical engine or persistence mechanics.
- Cake owns the desktop application model, project/session navigation, renderer
  projections, window and workflow state, artifacts, reviews, and other
  GUI-specific persistence. Never create a second Cake-owned copy of
  a Pi transcript.
- `src/services/pi` is the regular-Pi Service boundary; `src/services/pi-durable`
  contains the permanent coordinator's Durable adapter. Other Cake modules use
  Cake-owned values and domain operations rather than raw SDK objects.
- The shared backend owns Pi runtimes, filesystem access, and persistence.
  Electron main hosts it locally and adds native capabilities; remote Electron
  does not acquire a shadow backend. Preload exposes one narrow validated bridge.
  The sandboxed renderer owns React presentation and window-scoped Stores; it has
  no Node globals or raw Electron IPC.
- Services never import Cake domain, composition, or renderer modules, even for types.
  Backend and renderer implementations never import one another. Shared schemas,
  errors, values, and pure codecs consumed across layers belong in feature-named
  `src/contracts/` modules, not IPC infrastructure, implementation files, or
  forwarding facades. These directions remain architecture requirements reviewed in code;
  see `docs/architecture/effect-architecture.md` for the matrix. ESLint-only
  enforcement was removed with the migration to Oxlint.
- Cross-process data is untrusted until parsed by the shared runtime schemas.
- A Cake Chat Session is an application-level Cake Session backed by Pi. Keep
  it separate from Project Session lists and use curated Cake control intents
  for application navigation and coordination.
- Artifact content remains validated and views sandboxed. Explicit backend artifact
  logic is trusted for host functionality through canonical Cake commands; independent
  runtime lifetime is separate from disposable views and from Pi sessions. See the
  [artifact protocol](../architecture/s4-artifact-protocol.md).
