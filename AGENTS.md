# Cake agent instructions

## Required reading

- Read `PLAN.md` before changing architecture or feature ownership.
- For renderer state work, read the available `r-state-tree` skill and the references it routes to before editing.

## Greenfield compatibility policy

- Cake is a greenfield project. Unless the user explicitly requests it, do not preserve backward compatibility.
- Remove replaced APIs and implementations outright. Do not add deprecated aliases, compatibility shims, transitional forwarding facades, legacy import paths, migrations, or fallback behavior for code being replaced.
- Prefer updating every caller, test, and document in the same change over carrying an old interface forward.

## Renderer state architecture

- Treat each Store as a stateful behavioral component with one cohesive product or workflow responsibility.
- `RootStore` is the renderer composition root and event-routing boundary. A window-scoped lifetime does not make `RootStore`, a shell Store, or a generically named window-scoped Store the owner of every workflow in that window.
- Give named product surfaces named Stores: navigation/sidebar, project selection, active session/chat, changes, reviews, browse, settings, and similar independently evolving workflows.
- Compose Stores according to ownership and lifetime. Put a shared Store near the root; nest it only when its lifetime and behavior are truly owned by one parent surface.
- Parent Stores coordinate cross-Store work. They must not duplicate child state or expose one-for-one forwarding facades for a child's API.
- Existing concentration of unrelated state is a refactoring signal, not precedent for adding the next field or method there.
- Keep only tiny DOM, focus, hover, measurement, or isolated input state in React. Workflow state, async policy, persistence, subscriptions, and timers belong to a Store.

Before adding state, identify its authority, cohesive owner, lifetime, persistence boundary, and concurrency policy. If the proposed owner cannot be described without saying "everything in this window" or listing unrelated surfaces, introduce or use a focused Store instead.

## Verification

Run focused tests and the relevant typecheck or build for the files changed. Preserve unrelated worktree changes.
