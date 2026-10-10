# Permanent Cake Chat memory

Cake Chat is one permanent application-level coordinator. Execution belongs to independent
Project Sessions. Its only tools are `cake`, `zoom` and `date`; operation discovery and invocation
both enforce the coordination allowlist. Bang-prefixed input is literal text, not a shell escape.

## Persistence

Pi Durable's supplied SQLite adapter owns originals and runtime checkpoints. There is no mirrored
JSONL history or renderer notebook. Reasoning remains in originals but is excluded from summaries.
Application storage owns the history budget, optional summarizer override and dedicated instructions.
The shared Chat/ChatStore renders original-history pages and a transient live projection.

The clean-start cutover deletes only old active/resolved global histories, without importing them.
Project Session storage and lifecycle are unchanged. See [the backend boundary](cake-chat-durable.md).

## OptChat policy

Based on [the author's specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):

1. One original produces a leaf. Adjacent equal-sized ranges merge into binary parents. A short
   source is its own summary; longer sources target 512 UTF-8 bytes with up to five shortening
   attempts. The shortest result is retained, never arbitrary truncation of unsummarized text.
2. A serialized worker indexes sources incrementally. A source and its carry-chain parents commit
   atomically with the cursor. Only a small latest checkpoint is loaded at restart; originals and
   immutable nodes are retrieved lazily through the SDK storage API.
3. The chronological view grows at its end until it exceeds the upper budget, then merges toward
   half. Eligible sibling priority is `(T - lastMessageIndex) / childSize`, oldest first on ties.
   The exact view and ancestor pointers are persisted, not rebuilt on every run.
4. An explicit budget change refits the view. If it cannot fit, preparation fails visibly rather
   than sending unbounded history or silently dropping originals.

The default history-view budget is **40,000 UTF-8 bytes**, approximately 10k English tokens.
It excludes system instructions, tool definitions, current inputs and active-run activity. Token
counts vary by model and language. Summary generation uses the utility model unless explicitly
overridden; it never silently substitutes the main conversation model and incurs separate cost.

Inputs commit before potentially slow preparation. Each independent run gets a persisted bounded
memory view, backend UTC clock and current input. A parking reset keeps the active range bounded
if summarization fails. Tool rounds/steering retain active context; subsequent independent runs
refresh from the tree. SDK emergency compaction can finish an oversized active run, but does not
become another layer of permanent summary memory.

Dedicated current instructions remain outside summarized history. Compact worker results include
routing/provenance and usage, not entire child traces. Historical reports do not establish current
status: inspect live application/session facts before acting.

`zoom(id,n)` opens binary children; `zoom(id,1)` returns original text and images. `date(id)` returns
its backend-recorded timestamp. Zoom before guessing from a vague summary.

## Verification

- `tests/app/services/pi-durable/cake-chat-durable.test.ts`: fresh views, tool-loop zoom, bounded
  active heads, budget refits, deduplication, original pagination and summary failure recovery.
- `tests/integration/cake-chat-durable.test.ts`: production adapter/credentials/SQLite, scoped
  cleanup, reopen, inbox identity and payload preservation, steering, pending report recovery and
  shutdown during slow summarization.
- Cake Chat domain and renderer workflows: capability selection, utility default/override,
  singleton navigation, settings and shared chat behavior.
- `tests/electron/cake-chat.smoke.spec.ts`: isolated hidden Electron typing/focus/submission,
  restart, settings and cleanup, using a local fake provider.

Deterministic fixtures prove mechanics, not billed-provider latency, recall quality or cache-hit rates.
