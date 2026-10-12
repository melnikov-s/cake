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
  forwarding facades. `architecture/module-boundaries` enforces these
  directions in ESLint; see `docs/architecture/effect-architecture.md` for the matrix.
- Cross-process data is untrusted until parsed by the shared runtime schemas.
- A Cake Chat Session is an application-level Cake Session backed by Pi. Keep
  it separate from Project Session lists and use curated Cake control intents
  for application navigation and coordination.
- Model-presented artifacts are data and remain validated or sandboxed.
