# Renderer workflow integration testing

Use [`project-settings-dialog.test.tsx`](../../tests/app/renderer/project-settings-dialog.test.tsx) as the pilot for renderer workflow tests. Start at the real React product surface, not at a Store method. The goal is fewer valuable tests proving user workflows, without duplicating them in separate component and Store suites.

## Contract

1. Mount the real `RootStore` with `createRendererStoreFixture` and render the real feature component.
2. Use real projection Models and collaborating Stores, with coherent authority records from focused fixture builders.
3. Replace only external service boundaries using typed `Client` overrides.
4. Establish initial authority and surface state in a small feature-specific fixture. Opening a surface during setup is fine; do not perform the behavior under test there.
5. Drive workflow actions through accessible UI controls with React Testing Library and `user-event`.
6. Assert visible results and important service-boundary effects, not internal Store fields or calls to peer Stores.
7. Unmount React before disposing the Root fixture; use `using` for automatic cleanup.

Do not mock or hand-assemble Stores, Models, parent callbacks, or Store context. Do not mock internal modules with `vi.mock`. Do not use `as unknown as Client`; `createTestClient` validates service overrides and fails on unexpected service calls. Shared setup should expose the user interaction driver, not a facade for invoking workflow Store methods.

## Convert and consolidate

- Replace direct Store and mocked-component coverage of the same workflow rather than retaining parallel suites.
- Select meaningful user journeys, not a one-for-one translation of every old test.
- Preserve important failure, cancellation, and stale-result contracts when they affect the user. Drive their triggering action through the UI and control service completion with deferred promises, not elapsed-time sleeps.
- Drop implementation-only assertions; do not delete a meaningful contract merely because exercising it through the UI is harder.
- Do not add tests solely proving a removed feature is absent.
- Existing Store suites are migration backlog, not the template for new renderer workflow tests. Retain a narrowly documented regression when it has no honest replacement; do not invent UI wiring or mock a native editor just to delete its old test.

## Fixtures and service fakes

- **Fixture builders** create valid plain authority records. Share a builder when more than one test needs the shape; keep scenario-specific facts visible in the test.
- **Models and Stores** are real and freshly instantiated for every test. Never share mutable instances.
- **Service fakes** represent external authorities, such as Saved Draft storage. Return realistic responses and deliver projection updates when the real authority would do so; do not manufacture impossible state combinations.
- **The root fixture** owns common composition, projection initialization, typed Client construction, and disposal. Keep feature rendering and scenario defaults in small local fixture factories until there is demonstrated reuse.

## Choose the execution environment

React workflow tests live under `tests/app/renderer` and run with `pnpm test`. They integrate the real in-process renderer while replacing external services. Rendering a component in jsdom does not prove native browser or Electron behavior.

Focus, actual keyboard input, text selection, portals, and native DOM-event behavior require isolated Playwright Electron verification. Reuse or extend the relevant Electron workflow instead of duplicating its entire scenario in jsdom. Build the final application before running targeted smoke tests. A jsdom form test can establish service payload and rendered-state behavior, but cannot be presented as proof of native input/focus correctness.

Main/domain/service behavior outside React still belongs at its real integration boundary. Reserve `tests/integration` for tests driving real external services such as Git, Pi, subprocesses, bundlers, or network servers. This renderer policy does not imply routing backend-only behavior through an unrelated UI.
