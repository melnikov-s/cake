# Global artifact tools and backend runtimes

For independent executable logic, not ordinary widget rendering or chat output.

## Identity and retention

Use `artifacts.globals` for retained identities and `artifacts.viewing` for visible/active references in the correct window, including fullscreen. Do not assume the creator's artifact is what "this" means.
Inspect with `artifacts.inspect`, discover typed handlers with `artifacts.tools`, invoke `artifacts.call({lineageId,name,input})`. Handlers work with the view closed. Private saved-state replacement is not a semantic API.
`artifacts.set-global({lineageId,global:true})` retains any artifact kind independently of creator deletion. Global does not mean installed app: use Library, pinning and fullscreen.
`artifacts.delete` stops execution, removes schedules and deletes Cake-owned artifact data, not arbitrary outside files. Titles/descriptions are metadata.

## Attachment is the run gate

Backend logic runs only for a widget attached to a slot (`widgets.attach`, any target/slot including `tab`), and only at the revision that attachment shows: the instance's current revision. Unattached instances, older revisions and freshly published or instantiated widgets that are not attached never start a runtime, run a schedule or reach the Cake bridge; `artifacts.call`/`artifacts.runtime.start` fail with a "not attached" error. Detach, delete or a newer revision stops the old worker immediately, without overlap. Schedule configuration of an unattached widget stays dormant until it is attached again. `artifacts.runtime.status` reports `attachedRevision` (`null` when unattached).

## Runtime and command bridge

`artifacts.runtime.publish` publishes trusted independent QuickJS backend logic and typed tools. Disposable views do not own its lifetime; persistence is artifact-scoped and backend-owned.
Both view and runtime have the canonical Cake-command bridge for supported filesystem/network/shell operations and explicit-destination, artifact-attributed chat. Agent calls carry the actual caller; background calls invent no session.
Discover schemas with `artifacts.commands`; `artifacts.command` uses the same supported bridge. Not every Pi tool is a Cake command. Capability is determined by the exposed catalog, not invented access.
A handler must not synchronously invoke/control/publish its own runtime: those calls reject before changes to avoid waiting on itself. Use an external caller for lifecycle control. Read-only discovery and other artifacts remain usable.
Historical views must not activate duplicate effects.

## Shell-backed integrations

`shell.run({command,cwd,timeoutSeconds?,env?})` runs backend shell syntax, with required absolute cwd and inherited environment plus overlays. It needs no session/view.
Results separate bounded stdout/stderr, exit status and timeout/truncation flags. Check them before success claims. GUI PATH may require explicit env.PATH or absolute executable paths.
Use a timeout for shell work inside admitted semantic handlers. Discover the actual bridge schema before implementing; do not assume a Pi bash tool contract.

## Durable schedules and lifecycle

`artifacts.schedules.configure/list/remove` uses the durable automation worker to invoke handlers without an LLM or conversation message. Overdue work of attached widgets catches up once after restart or re-attachment; backend-off means no execution.
Runtime pause stops logic and pauses background until explicit resume. Opening/start/restart does not silently resume schedules; tools remain discoverable.
Inspect runtime/schedule receipts, not configuration alone. Deterministic examples with fake network/chat do not demonstrate a live PR integration.
Exact operation help supplies schemas. Repository developers can consult docs/development/global-artifact-authoring.md for source/lifecycle/SDK/persistence/schedule examples; that repository path is not part of the installed guide bundle.
