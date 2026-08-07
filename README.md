# Cake

Cake is a minimal Electron desktop coding agent powered by Pi. The project is
ready to begin **Stage S1 — Pi-backed desktop chat** from [PLAN.md](./PLAN.md)
after completing the S0 foundation contract.

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

The current shell starts a sandboxed renderer, exposes only a typed preload API,
and creates an in-memory Pi session in an Electron utility process. The
foundation check runs a Pi extension command, displays its `confirm` request in
React, returns the response, and projects Pi session events through Cake-owned
runtime schemas and an `r-state-tree` `WindowStore`.
