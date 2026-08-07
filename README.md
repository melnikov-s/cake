# Cake

Cake is a minimal Electron desktop coding agent powered by Pi. The project is
currently implementing **Stage S0 — Foundation contract** from [PLAN.md](./PLAN.md).

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
```

The current shell starts a sandboxed renderer, exposes only a typed preload API,
and streams a deterministic message from an Electron utility process. It does
not create a Pi session yet.
