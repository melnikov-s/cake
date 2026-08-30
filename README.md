# Cake

Cake is Pi expressed as a desktop GUI. Pi remains the coding-agent and session
engine; Cake adds a web-native conversation surface, rich artifacts and
workflows, navigation across projects and sessions, and a Pi-backed global chat
for reasoning about the application as a whole.

Cake is a single application package organized by Electron process boundaries:
`src/main`, `src/preload`, `src/renderer`, the Cake-specific Pi adapter in
`src/agent`, and validated contracts in `src/ipc`. See
[Cake architecture](./docs/architecture/cake-architecture.md) for its product,
authority, state, trust, and development model.

## Development

Requirements: Node.js 22 or newer and Corepack.

```sh
corepack pnpm install
corepack pnpm dev
```

Verification:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint
corepack pnpm build
corepack pnpm test:electron
```

Run `pnpm dev` for the normal Electron development loop. Renderer changes use
Vite hot module replacement; changes to main or preload rebuild and restart the
Electron process automatically.

Run `pnpm dev:agent` when an automation agent also needs to inspect or navigate
the Electron renderer. It exposes the development-only Chrome DevTools Protocol
endpoint at `http://127.0.0.1:9222`; Playwright can attach with
`chromium.connectOverCDP("http://127.0.0.1:9222")`. Do not expose that port in a
packaged build.

Run `pnpm dev:manual` to disable renderer HMR. Renderer edits become visible only
after choosing **Developer → Reload Cake** or pressing `CommandOrControl+R`.
Changes to main or preload still restart Electron automatically.

The app starts a sandboxed renderer, exposes only a typed preload API, and runs
Pi directly through its SDK in Electron's main process. It supports project
trust, provider login, model and thinking controls, Cake-owned transcript parts,
tool activity, prompt/steer/follow-up/abort, file and image inputs, and
hydration-gated renderer state through an `r-state-tree` `RootStore`. Pi session
snapshots are applied one-to-one to reactive `SessionModel` instances. Focused
behavioral Stores own navigation, project/session selection, chat, changes, reviews,
browsing, and other product surfaces; window lifetime alone does not make one Store
the owner of every renderer workflow.

Live provider tests are intentionally opt-in: signing in or sending a real
model request can open external authentication and incur provider cost.
