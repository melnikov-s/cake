# Pi 1.0 upgrade assessment

## Status and scope

The assessment below was researched against Cake's **0.85.1** integration before
implementation. Cake now pins **1.0.0** for the minimal compatibility upgrade;
see [the current Service contract](../architecture/pi-1.0-contract.md). New-feature
adoption recommendations below remain deferred. Findings below come from the published
`@earendil-works/pi-coding-agent@1.0.0` tarball, its documentation and exported
implementations, the related package changelogs at tag `v1.0.0`, and Cake's current
Pi adapter. They are not a completed compatibility test.

Pi 1.0.0 was released on **2026-10-01**. The relevant upgrade includes **0.86.0,
0.86.1, 0.87.0, 0.87.1, 0.99.0, 0.99.1, 0.99.2, and 1.0.0**, not just the final
1.0 section. In particular, MCP, codemode, classifiers, image-model runtime
support, and virtual models arrived in 0.99.0.

Primary version-pinned sources:

- [Coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md)
- [AI changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/CHANGELOG.md)
- [Agent-core changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md)
- [TUI changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/tui/CHANGELOG.md)
- [SDK](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/sdk.md)
- [SDK codemode/MCP example](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)
- [Extensions](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md)
- [Codemode](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md)
- [MCP](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/mcp.md)
- [Virtual models](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/virtual-models.md)
- [Models](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md)
- [Settings](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/settings.md)
- [Session format](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/session-format.md)

## Recommendation

Upgrade the embedded SDK first, then explicitly integrate Pi's built-in MCP,
codemode, and tool-search extensions for Project Sessions. Keep the initial
codemode setting at `on`, not `only`. Do not automatically expose MCP or scripting
to Cake Chat, read-only Discussion Sessions, or bounded Subagent Sessions.

Next, take advantage of image generation through Pi's credential-resolving runtime
and Cake's existing media/file/artifact surfaces. Trial virtual models and
classifier-assisted features separately, as explicit user choices rather than
silent changes to existing model presets or utility-model policy.

Pi remains the agent engine. None of these additions calls for replacing Cake's
Effect RPC boundary, conversation projections, Session Family workflows, or
shared Chat component.

## Capability inventory and Cake opportunities

### 1. Native MCP

Pi now ships MCP support instead of requiring a third-party extension. It supports
stdio and streamable HTTP, tools, resource listing/templates/reads, progress,
cancellation, connection recovery, OAuth, and session-scoped extension server
registration through `pi.registerMcpServer()`.

- User configuration lives in the Pi agent directory's `mcp.json`; project
  configuration lives in `.pi/mcp.json` and requires project trust.
- Server exposure can be `codemode` (default), `deferred`, `direct`, or `hidden`,
  with per-tool exact-name/pattern overrides.
- Large tool catalogs stay out of the model's initial declarations. Tool search
  can declare selected tools; scripts can discover and call them directly.
- Connections start in the background. The first prompt waits only for servers
  with direct tools, by default for up to ten seconds. Other servers are waited
  for when needed.
- The system prompt carries concise server summaries. `describeNamespace()`
  returns longer instructions without bloating every tool declaration.
- Tool calls pass through Pi's normal permission and result hooks, including
  nested calls. Annotation hints are advisory, not a verified security policy.
- Resources support text, images, and binary-file results. **MCP Apps are not
  rendered**: `ui://` and MCP-App HTML resources are omitted by Pi.
- Names normalize punctuation, with hash suffixes for colliding tool names;
  server names differing only by `-`/`_` cannot coexist.
- Direct model-facing MCP text is truncated above 20 KB with a full-output file;
  codemode gets the full result. Calls are not automatically retried merely
  because an HTTP error might be transient: side effects may already have run.

**Cake opportunity:** make existing MCP configurations genuinely work in Project
Sessions, with status, sign-in, reconnect, and discoverable tools. Start with the
RPC-compatible `/mcp` commands; add focused GUI configuration/status only when
needed. Do not build a second MCP client or credential store in Cake.

**SDK caveat:** MCP is not automatically installed into an SDK session. Supply
`createMcpExtension()`, `createCodemodeExtension()`, and
`createToolSearchExtension()` through `DefaultResourceLoader.extensionFactories`,
then bind extensions so `session_start` runs. Pi exports all three factories
from `@earendil-works/pi-coding-agent`; Cake need not import their transitive
packages directly.

Use named `builtin: true`, `replaceable: true` entries where Cake wants CLI-like
built-in enable/disable and replacement semantics. A plain inline factory does
not automatically honor the same built-in resource controls. Existing third-party
extensions registering `/mcp`, `codemode`, or `tool_search` can replace Pi's
replaceable built-ins; expose the resulting diagnostics instead of loading both.

### 2. Codemode and composable tools

The model can write JavaScript that calls tools, runs calls concurrently, and
filters/aggregates results before returning them to the model. This can avoid
multiple provider round trips and huge tool-result context.

- QuickJS runs scripts without Node globals, direct filesystem access, network,
  or timers. Access to the outside world is through allowed tools and models.
- The sandbox does **not** undo tool side effects or sandbox the tools themselves.
  Completed calls remain real if a later line fails; outstanding calls are
  cancelled when the script ends.
- Defaults include a 256 MB VM, 10,000 output tokens, and no whole-script timeout.
  An options comment can bound output and duration; large output goes to a file.
- Globals include `tools`, `text`, `image`, `store`/`load`, `searchTools`,
  `describeTool`, `describeNamespace`, and `models`.
- The small JSON store persists on successful scripts as Pi custom entries and
  follows branch/resume history. It is not for images or bulk output.
- `on` retains direct tool declarations; `only` hides callable direct tools so
  the model reaches them through scripts. The inline declaration budget defaults
  to 3,000 estimated tokens.
- The 1.0 changelog's approximately 40% reduction is a **particular prompt
  comparison** (about 5,300 to 3,300 tokens with GPT-5.6), not a measured Cake
  speedup or universal cost reduction.
- 1.0 improves recovery hints for unknown members, malformed model arguments,
  unavailable models, oversized stored values, and generated images not shown.
  Existence checks should use `"name" in tools`, not `typeof tools.name`.
- Bash/PowerShell structured results give scripts up to 1 MiB plus truncation,
  full-output path, exit code, and duration; model-facing text retains its
  existing 2,000-line/50 KB bound.

Tool APIs now support `exposure`, `namespace`, annotations, `outputSchema`,
`structuredContent`, `isError`, `prepareLoadout()`, and `ctx.executeTool()`.
Exposure distinguishes directly declared tools, `model-only` tools, callable
codemode/deferred tools, and hidden tools. `model-only` suits orchestration or
user-interaction tools that should not themselves be called by scripts.

**Cake opportunity:** faster repository exploration, multi-file reads, MCP queries,
and structured reductions. Start opt-in alongside ordinary tools. Audit Cake's
own gateway before making every application-control operation script-callable;
mark interaction/orchestration surfaces appropriately. Add structured results
only where they improve programmatic use, rather than redesigning the whole
operation registry during the dependency bump.

### 3. Image generation

`ModelRuntime.generateImages()` now resolves provider authentication, stored/OAuth
credentials, runtime API keys, and `models.json` headers. Chat, image, and
classifier models share the provider/catalog layer but remain different model
types. The same provider/ID can exist once per type.

1.0 adds `models.generateImages()` inside codemode. Scripts can pass text and
reference images, then attach returned base64 images with `image()`. These calls
report usage through the enclosing tool result. Generated images are **not saved
to disk automatically**. OpenRouter supplies built-in image models using the same
credential as its chat models. Extensions can generate images without codemode.

**Cake opportunity:** generate/edit illustration assets, mockups, and presentation
images in the conversation. Cake already projects tool-result image blocks; test
that path with generated images before building another media viewer. Saving,
downloading, and publishing a durable artifact are distinct explicit operations.
Keep image models out of the chat-model picker, and discover them through the typed
model catalog rather than hard-coding IDs or adding another provider SDK.

### 4. Classifier models

Pi includes TypeSafe/Jev classifiers with provider-neutral `choice`, `score`, and
`bool` questions over JSON state, typed answers, probabilities, and usage.
Available sources include TypeSafe directly, OpenRouter, Cloudflare Workers AI,
Vercel AI Gateway, OpenCode Zen, and llama.cpp chat models exposed as classifiers
through next-token label probabilities.

Codemode scripts can discover available classifiers and call `models.classify()`;
extensions can call `ctx.modelRegistry.classify()` directly. Codemode permits up
to four concurrent classifier/image calls per script. Calls return explicit
stop/error/aborted outcomes; callers must check them.

**Cake opportunities:** rerank an artifact/session search shortlist, score review
relevance, or supply a bounded complexity judgment to a router. Ask independent
questions together, keep exact rules and execution in code, and measure accuracy
on representative Cake cases. Probabilities are not authorization, proof of
completion, or grounds for automatic Session Family resolution.

Keep optional background classification under explicit user configuration and
Cake's utility-work policy; do not silently substitute Jev for a chosen utility
model. Catalog-priced usage is useful, but a reported zero cost for a model with
no price metadata does not mean the service is free.

Pattern references: [TypeSafe intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)
and [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md).

### 5. Experimental virtual models

`pi.registerVirtualModel()` registers a selectable model whose router chooses a
physical model and thinking level for each request. Pi owns route dispatch,
branch-persistent router state, resume, and compaction against the selected
physical model's context limit.

- Selected virtual identity and actual response identity are deliberately distinct.
- Assistant messages name the physical model and now record requested thinking
  level. Model-change entries preserve the virtual selection.
- Route reasons distinguish user input, continuation, retry, and direct calls
  such as summarization.
- Continuing/retrying on the same physical model preserves caches and thinking
  signatures; switching models is permitted but has a cache cost.
- Routers can use classifiers, adding latency before the first token.
- A virtual model cannot route to another virtual model or an unauthenticated one.

**Cake opportunity:** an explicit Auto preset or strong-planner/cheaper-builder
workflow without a Cake-owned router loop. Keep fixed presets fixed. Display both
selection and actual responder, including physical thinking level and costs.
Treat this as experimental and measure total savings including routing calls,
cache misses, and response quality. Pi's Jev router example is a useful reference,
not a production default or a promise that switching after the first edit is
appropriate for Cake.

### 6. Context, instruction updates, and lifecycle

0.86 stores initial system prompt/tool declarations and subsequent changes as
transcript system messages. Resume and branch navigation now preserve those
changes; supported providers preserve cached prefixes, while others receive a
collapsed prompt/checkpoint.

0.87 makes `SessionManager` canonical for finalized provider context. The new
append-only `context_edit` entry can omit or replace a message's future context
contribution **without rewriting raw history, exports, usage, or UI history**.
`refreshContext()` refreshes after public manager operations. A retain-none
compaction can use its own entry as the retained boundary.

Lifecycle additions:

- Actionable `turn_end` and `agent_before_settle` boundaries can append validated
  entries and request one continuation without replacing queue scheduling.
- `agent_settled` remains final/notification-only; requested runs wait until all
  settled handlers finish.
- `context` sees conversation messages, not prompt/tool system messages;
  `context_with_system` can transform the full request transcript.
- Low-level agent hooks add `prepareRequest`, `finishTurn`, and queue peeking.
- `pi.on()` returns an unsubscribe function.
- Extensions can stream through credential-resolving `ctx.modelRegistry.stream()`
  and `streamSimple()`.

**Cake opportunity:** eventually let users exclude bulky context while preserving
an inspectable transcript. This is not the same contract as Cake's existing
branch-creating tool-compacted continuation, so do not silently replace that
feature in the upgrade. Preserve full-branch display and continue using settled,
not low-level `agent_end`, to decide that a Cake turn has completed.

### 7. Cache warming and model-specific budgets

Pi now warms eligible prompt caches during long active runs, optionally while idle.
The default is `cacheWarming: "streaming"`; `idle` adds between-run warming and
`off` disables it. This is a global setting. Warming requires catalog cache-lifetime
metadata and an estimated avoided miss cost of at least $0.05.

Refresh usage contributes to session totals through Pi `usage` entries without
entering model context. Extensions can override idle decisions. The SDK factory
constructs the cache warmer, so this is not merely a CLI feature.

Compaction can now set exact `provider/modelId` overrides for `reserveTokens` and
`keepRecentTokens`. Image input can use model-specific resize profiles, encoded
once before persistence; changing models does not rewrite historical images.

**Cake opportunity:** fewer expensive cold-cache returns after long tools, better
small/large-model compaction tuning, and predictable attachment sizes. Surface
warming cost honestly. Keep Pi as the timer/decision authority; do not add a Cake
warming loop. Reverify Cake's fork cache-lineage payload policy with warming.

### 8. Authentication, providers, and catalog

- Sign in with ChatGPT is now available on the `openai` provider. `openai-codex`
  is labeled legacy, not removed. Existing credentials/presets should not be
  silently rewritten to another provider.
- The new login requires `LoginOptions.getDeviceId()` returning a stable UUID
  for the installation. Pi's CLI stores it in global Pi settings.
- Anthropic adds a copy-code method for remote/headless use, plus workload
  identity federation using the SDK environment variables.
- Radius login can offer setup of its MCP server with `auth.provider: "radius"`.
  That top-level menu/setup is CLI workflow, not an automatic SDK side effect.
- MCP OAuth adds client-name and metadata-URL overrides, RFC 9207 issuer checks,
  credentials keyed by server name and URL, and additional-scope sign-in that
  retains previously granted scopes. HTTP MCP can use an explicitly configured
  provider token; this is restricted to global configuration/extensions and HTTPS
  except loopback.
- New frontier catalog entries include Claude Opus/Sonnet 5.5, GPT-6 Sol/Luna,
  GPT-6.1 Sol, and Grok 4.7 across supported providers. Codex's new default is
  GPT-6.1 Sol; xAI defaults to Grok 4.7. Some defaults move from retired Kimi K2.6
  to Kimi K3. Unavailable GPT-5.4/mini Codex entries are removed.
- Meta/Muse is highlighted in 0.86.1, but the 0.85 notes already mention it;
  do not present all repeated/inherited release highlights as newly absent in Cake.
- Mixed catalogs refresh chat, image, and classifier types. Existing unqualified
  catalog reads remain chat-only. A lightweight `pi-ai/models` import is new.

**Cake opportunity:** better provider sign-in using the existing typed auth UI.
Add installation-ID plumbing before advertising the new ChatGPT flow. Audit Fast
mode separately: Cake currently restricts it to an old hard-coded Codex model
list, so new models and OpenAI sign-in do not gain the toggle just by upgrading.

### 9. Diagnostics, packages, and terminal-only features

Pi adds `/bug` with redacted environment/settings/provider diagnostics, optional
transcript or model-written summary, ZIP export or private Radius upload, crash
records, and a recorded report ID. Uploads require explicit user consent; do not
blindly send a Cake session to Pi support. Cake-owned failures and Pi-owned
failures remain different support targets.

Package improvements prevent installing duplicate host Pi peer dependencies,
warn on improper dependency declarations, refresh changed pinned git extensions,
and defer extension compilation/virtual modules until needed. Built-in extension
sources are named `builtin:<name>` in diagnostics and can be disabled through Pi
configuration. `defaultTools` supports additive `+name`/`-name`; reload enables
newly added defaults without indiscriminately resetting active tools.

Terminal changes include fullscreen by default, a terminal-palette-derived system
theme, OKLCH/OKHSL/short-hex theme colors, extension theme/style APIs, automatic
wheel acceleration, `quietStartup: "header"`, native async clipboard helpers,
Finder file-path paste, better autocomplete, cursor/selection fixes, and reduced
rendering CPU/memory. TUI 1.0 exposes the last rendered screen lines.

**Cake impact:** package and runtime fixes matter; terminal presentation generally
does not. Cake's React transcript, CSS theme, native clipboard, and composer do
not inherit TUI improvements. Continue explicitly diagnosing unsupported TUI-only
extension UI rather than pretending to render terminal components.

## Upgrade requirements and observed integration gaps

1. **Pin and lock the Pi cohort.** Update Cake's three direct Pi dependencies
   (`pi-ai`, `pi-coding-agent`, `pi-tui`), regenerate the lockfile, update the
   minimum-release-age exclusions for the actual resolved cohort, and update
   `piRuntimeVersion` and current contract documents. Pi adds transitive
   `pi-mcp`, `pi-codemode`, and QuickJS dependencies.
2. **Node minimum.** Published coding-agent 1.0 requires Node >=22.19.0 versus
   Cake's declared >=22.0.0. Check development, standalone backend, and packaged
   Electron environments; align the declared minimum. Pi targets ES2024 and its
   source workflow uses Node type stripping/TypeScript 7; Cake does not need to
   adopt TypeScript 7 simply to consume compiled packages.
3. **Normalized provider context.** Low-level provider streams now require branded
   `TranscriptContext`, not raw `Context`; custom providers read system/tool
   state through helpers. Cake's retry wrapper derives its type from Pi and
   forwards context unchanged, but its test fixture currently uses raw `Context`.
   Update those fixtures through normalization. `ModelRuntime.completeSimple()`
   still accepts ordinary `Context`; do not mechanically rewrite valid callers.
4. **JSON-only tool values.** Audit tool arguments/details and schema conversions
   against Pi's stricter JSON-compatible conditional types and readonly arrays.
   Do not solve incompatibilities with unchecked casts.
5. **Canonical context and new entries.** Audit `SessionEntry`/message switches for
   `context_edit`, `usage`, and system messages. Test restoration, branch changes,
   tool compaction, and complete display history separately from model context.
   Direct writes to `agent.state.messages` are no longer a restoration mechanism.
6. **Lifecycle contracts.** `shouldStopAfterTurn` is removed in favor of
   `finishTurn`. Event shapes and actionable boundary dispatch changed; hosts
   manually emitting `turn_end` must use the new boundary API. The initial Cake
   search found no use of the removed stop hook or experimental agent harness.
   Still verify extension fixtures and boundary-dependent continuations.
7. **Nested activity.** Cake's live projector currently renders every execution
   event as a top-level tool and ignores `parentToolCallId`. Pi persists nested
   call metadata only on the parent's result as bounded `nestedCalls` (not
   separate child transcript entries or full child results). Reconcile live and
   restored projection before enabling codemode broadly. Do not promise durable
   child outputs that Pi does not persist; respect incomplete/truncated records.
8. **Structured results and usage.** Project model/image output and nested usage
   without double counting. Pi propagates nested tool usage into the parent;
   Cake should continue using Pi's totals. Check that warming-only updates reach
   an idle GUI as well as appearing after the next snapshot.
9. **Queued input disposition.** `steer()`/`followUp()` return `queued` or
   `handled`, after extension input handlers. Cake currently ignores those
   results while holding queues and infers handling from global runtime state
   during submission. Test extension-consumed/transformed input during an active
   turn and stop/requeue, not just idle handling. `prompt()` still returns void;
   its disposition callback is documented as internal RPC plumbing, not a new
   public return value to invent for Cake.
10. **Provider and virtual registration.** Cake manually flushes pending legacy
    and native provider registrations before initial model selection, but not
    pending virtual registrations. Pi's 1.0 SDK still resolves the initial model
    before session binding. Integrate queued virtual models into initialization,
    sessionless discovery, and reload before supporting virtual selections.
    Reassess existing provider workaround code against 1.0 instead of assuming
    every related upstream fix replaces it.
11. **ChatGPT installation ID.** `PiModelsLive.login()` currently passes only the
    interaction, not `LoginOptions`. The 1.0 OAuth implementation explicitly
    rejects missing/non-UUID installation IDs. Reuse Pi's global setting access
    and persist through Pi's settings manager rather than inventing another
    credential/identity file. Scope the identity to the backend installation
    that owns login, including headless/remote use.
12. **SDK built-ins and capability isolation.** Explicitly register the new
    factories in the correct resource loader. Audit fixed `tools` allowlists,
    `noExtensions`, built-in overrides, and read-only profiles; do not copy the
    CLI's unrestricted defaults into every Cake Session kind.
13. **MCP UI and native routing.** Cake binds extensions in RPC mode. Pi's `/mcp`
    uses status/direct actions outside TUI, so its terminal manager is not a
    ready-made Cake settings screen. Wire the public `openUrl` option through
    Cake's native-device routing for remote backends; retain supported UI prompts
    and cancellation. Do not spawn a browser on the server by accident.
14. **Packaged execution.** Verify the codemode worker and WASM assets from the
    compiled Electron app and standalone backend. Current builds externalize
    dependencies; source-only success is not enough to prove worker/asset paths
    survive deployment.
15. **No harness migration.** Agent-core 1.0 removes experimental durable harness
    exports into `pi-durable`. Cake embeds coding-agent `AgentSession` and
    `SessionManager`, which remain supported. Do not migrate its transcripts to
    a different harness merely because a new package exists.

Relevant Cake implementation locations:

- `src/services/pi/runtime/cake-session-runtime.ts`
- `src/services/pi/runtime/cake-session-runtime-capabilities.ts`
- `src/services/pi/runtime/cake-session-runtime-event-projection.ts`
- `src/services/pi/runtime/cake-session-runtime-turn-controller.ts`
- `src/services/pi/runtime/extension-providers.ts`
- `src/services/pi/runtime/session-projection.ts`
- `src/services/pi/runtime/session-tool-compaction.ts`
- `src/services/pi/runtime/response-retry.ts`
- `src/services/pi/live/PiModelsLive.ts`
- `src/services/pi/fast-mode.ts`

## Reliability gains worth taking immediately

The cumulative changelogs contain many fixes that Cake gets through the engine,
without reproducing them in the GUI:

- Session persistence begins on the first user message, not the first assistant
  response; interrupted new conversations are less likely to disappear.
- Recovery context edits omit abandoned retries from future model input while
  retaining history/accounting; compaction handles edited and oversized context
  more correctly and has better cancellation ordering.
- Provider overflow detection, quota/retry classification, malformed Retry-After
  handling, and capped agent retry delay improve failure recovery.
- Anthropic and compatible-provider strict-schema handling degrades appropriately
  for unsupported schemas rather than failing requests.
- Thinking replay, requested effort, image-only prompts, and Copilot GPT adapter
  selection improve cross-provider correctness.
- Fast-mode pricing and one-hour cache-write pricing become more accurate.
- Malformed Responses tool streams fail rather than executing mixed-up calls;
  grammar tool-call replay across providers is repaired.
- MCP OAuth issuer/scope/token handling and resumed deferred-tool restoration are
  corrected; invalid codemode images are rejected before poisoning later turns.
- Prompt submission/model lookup and event-stream draining avoid quadratic work;
  SDK extension compiler loading is deferred.

Cake's special empty-response/empty-429 retry policy is not automatically replaced
by those fixes. Reverify it against Pi's new quotas, recovery, cache warming, and
routing; retain only the intentional Cake-owned policy rather than stacking
redundant generic retries.

## Suggested implementation sequence and verification

### A. SDK compatibility upgrade

Bump/lock dependencies and Node floor; fix compile errors and explicit adapter
gaps. Preserve existing features. Run the deterministic foundation runtime,
provider catalog/auth, conversation display, turn-controller, queue-stop,
retry/recovery, session discovery/fork, tool compaction, side-chat, and extension
compatibility tests. Add regression cases for the new transcript values and
active-run input handling. Update versioned contract documentation only after
verification.

### B. Native MCP and opt-in codemode

Register named built-ins for Project Sessions. Test real Pi coordination against
controlled in-memory MCP transports: direct/codemode/deferred exposure, delayed
connection, search, permission blocking, structured errors, nested usage,
reload/resume, cancellation, and shutdown. Cover untrusted project configuration
and absence of these capabilities in intentionally restricted session profiles.

Project nested activity through Cake's validated contracts and authoritative
Chat, with live-to-reopened consistency. Build and run focused Electron tests for
extension dialogs, nested activity, images, ordinary composer typing/submission,
and slash-command keyboard handling. Include a packaged worker/WASM execution
check without external provider credentials.

### C. Media and tuning

Validate generated-image projection, file save/publication, aborts, usage, and
missing credentials through controlled model-operation boundaries. Surface
cache-warming policy/cost and per-model compaction controls only where useful.
Fix new-model Fast-mode eligibility based on verified upstream capabilities.

### D. Experimental routing/classifier product trials

Offer virtual selections explicitly, with selected/physical identity kept
separate. Test registration-before-selection, resume/fork, sticky continuations,
retry routing, smaller-context compaction, authentication failure, and cancellation.
Evaluate classifier/routing quality, time-to-first-token, total cost, and cache
behavior before making any product default.

Format changed files, run Oxlint and focused tests, typecheck/build, and perform
only the relevant isolated Electron smoke tests. Neither all-provider live tests
nor the full E2E suite is necessary for each iteration. No Pi 1.0 build, typecheck,
or runtime tests were run as part of this research-only assessment.
