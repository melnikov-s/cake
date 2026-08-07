# Cake

Cake is a minimal Electron desktop coding agent powered by Pi. The eight
implementation work items for **Stage S1 — Pi-backed desktop chat** are now in
place; live-provider acceptance verification remains opt-in before the stage is
marked complete in [PLAN.md](./PLAN.md).

Cake is a single application package organized by Electron process boundaries:
`src/main`, `src/preload`, `src/renderer`, the Cake-specific `src/agent` utility
process, and validated contracts in `src/ipc`.

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

The app starts a sandboxed renderer, exposes only a typed preload API, and runs
a persistent Pi session in an Electron utility process. It supports project
trust, provider login, model and thinking controls, Cake-owned transcript parts,
tool activity, prompt/steer/follow-up/abort, file and image inputs, and
hydration-gated window state through an `r-state-tree` `WindowStore`.

Live provider tests are intentionally opt-in: signing in or sending a real
model request can open external authentication and incur provider cost.
