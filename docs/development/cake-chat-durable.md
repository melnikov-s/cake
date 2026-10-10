# Cake Chat Durable backend

## Live boundary

`BackendLive` provides `CakeChatDurable` to `CakeSessionRuntimes`. Only the permanent global
coordinator uses Pi Durable 1.1 and its supplied Node SQLite adapter. Project Sessions retain
coding-agent 1.0, their JSONL journals, worktrees and existing lifecycle.

The database is `<CAKE_HOME>/pi/global-chat/coordinator.sqlite`. The old global `sessions` and
`resolved-sessions` roots are deleted without import. Cleanup validates both namespace paths;
it never traverses Project Session storage. There is no JSONL coordinator fallback.

## Authority and lifetime

- Durable owns admission, its persisted inbox, generation/tool tasks, checkpoints and recovery.
  SQLite is the sole coordinator transcript authority; Cake does not implement a SQL store.
- `CakeChatDurable` is a construction/read adapter. `CakeSessionRuntimes` retains ownership of
  shared scoped runtime leases. Once assembled, the permanent coordinator has one application-scoped
  lease so worker reports can wake it after its pane closes; application shutdown closes the Harness.
  See [spawned-session reporting](./spawned-session-reporting.md) for requester and delivery policy.
- Catalog/preview readers use the SDK's document kernel without a Harness. They cannot create
  a conversation, load providers, resume tasks or invoke scheduler recovery cleanup.
- Model requests use Cake's existing ModelRuntime credentials and custom/extension providers.
  Normalized contexts cross the versioned SDK boundary explicitly; SDK collections are wrapped
  with receiver-preserving facades, not object spreads that discard prototype methods.
- Raw SDK types stay in `src/services/pi-durable`. The renderer uses the shared `Chat`,
  `ChatStore`, Conversation contracts and typed history RPC.

## Memory and run boundaries

Original user, assistant and tool-result entries stay on disk. Immutable summary entries hold
an original pointer or two binary child pointers. One latest-only document holds the source
cursor, logarithmic forest and exact budgeted view references. Nodes are not document families:
the SDK retains loaded document trackers, so a document per lifetime node would leak memory.

Each source's leaf, carry-chain parents and checkpoint commit together after summarization.
A failed summary leaves that source unconsumed. Recovery loads the small checkpoint and reads
nodes/originals lazily, not a lifetime array or cache.

Inputs are admitted before memory preparation. At an independent run's first provider boundary,
a bounded parking reset is persisted before slow summarization. The fresh memory/current-input
reset and boundary marker then commit together. Preparation failure becomes a visible model
error; it never falls back to lifetime context. Shutdown marks the Harness closing before cancelling
preparation, preserving the pending request checkpoint for restart.

Tool rounds and steering retain active context. Durable's final-answer boundary creates a new
run even for steering; persisted input metadata lets the adapter preserve Cake's continuation
view in that case. Normal follow-ups and worker reports get fresh views. Stop preserves the
inbox. Send-now places exactly the selected existing submission in one SDK transaction, keeping
its turn identity and other queued inputs rather than cancelling and copying them.

Emergency compaction remains SDK-owned. The next independent run returns to the memory tree.
Dedicated instructions are externally authoritative and are not summarized.

## Controls and presentation

Only `cake`, `zoom`, and `date` are registered. The gateway is operation-allowlisted; there is
no shell or execution environment, including no `!` escape. Cake mutations are replay-unsafe:
after an interrupted tool intent the model must inspect authoritative live state, not blindly
repeat a session spawn. Zoom/date are read-only and replay-safe.

Only compact worker results and provenance/usage metadata enter coordinator inputs, not worker
tool traces. The SDK usage ledger reports coordinator model/tool usage; memory summarization
has separate utility-model cost, and Project Session usage remains in its own session.

Ordinary snapshots scan at most 200 underlying records per page and contain originals plus the
current live/inbox projection. Snapshot facts are read on one Session line to avoid showing a
completed original together with a stale partial. Derived nodes, resets and system declarations
are not GUI history. Explicit older-page loading lives in transient window projection state and
survives live snapshots; it is cleared on chat-store disposal. Admission metadata preserves queued
Markdown/image/source payloads and is stripped from provider requests and displayed history.

## Verification

```sh
pnpm test tests/app/services/pi-durable/cake-chat-durable.test.ts
pnpm test:integration tests/integration/cake-chat-durable.test.ts
pnpm build
pnpm exec playwright test tests/electron/cake-chat.smoke.spec.ts tests/electron/pi-durable.smoke.spec.ts
```

The SDK SQLite adapter uses WAL and `synchronous=NORMAL`: process-crash recovery is supported,
but newest commits are not guaranteed against machine power loss. One backend process owns
the database; the SDK supplies no cross-process ownership lock.
