# Visual capture harness

Cake owns a small Playwright harness for repeatable screenshots of Cake UI. It seeds isolated data, launches the compiled Electron application, waits for the real renderer and scenario-specific asynchronous work, applies a named interaction, and writes a PNG. It does not use a localhost browser preview or add development-only behavior to the Cake product.

## Usage

```sh
pnpm visual:capture --help
pnpm visual:capture --list
pnpm visual:capture assistant-markdown-code
pnpm visual:capture assistant-markdown-code --state hover --theme light
```

The command builds Cake before launching it. Use `--no-build` only when `out/` is already current, such as after an explicit `pnpm build`. Each run creates isolated temporary `CAKE_HOME` and Electron user-data directories and removes them after success or failure.

Named scenarios define their own fixture, readiness checks, allowed states, interactions, and capture region. Add scenarios under `scripts/visual-capture/`; do not add an arbitrary selector/action command language. The initial `assistant-markdown-code` scenario supports `default` and `hover` states.

Useful deterministic controls include:

- `--theme light|dark`
- `--width` and `--height` for the Electron renderer viewport
- `--capture region|window` for the scenario-owned region or full app content
- `--output <file.png>` or `--output-dir <directory>`

By default, PNGs are written beneath `.visual-captures/`, which is ignored by Git. Use a tracked location only when intentionally creating a reviewed fixture or baseline.

## Output contract

A successful run prints a short path summary followed by one stable line beginning with `VISUAL_CAPTURE_RESULT `. The remainder of that line is JSON containing schema version, scenario, state, captured PNG dimensions, absolute output path, MIME type, and SHA-256 checksum. This lets agents and automation consume the result without scraping the human summary.

A failed build, fixture setup, readiness check, interaction, or screenshot exits nonzero and identifies the scenario/state and intended file. Generated captures remain ordinary workspace PNG files: link them in chat, or present/import them through `artifacts.present` when that separate generic capability is available. The harness does not depend on artifact presentation.
