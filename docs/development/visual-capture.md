# Visual capture harness

Cake owns a small Playwright harness for repeatable screenshots of Cake UI. It seeds isolated data, launches the compiled Electron application or a real Chromium browser against the compiled Cake server/browser host, waits for scenario-specific work, applies a named interaction, and writes a PNG. Browser captures are actual Cake browser pages backed by an isolated local Cake backend—not a Vite preview or decorative mock. No development-only behavior is added to the product.

## Usage

```sh
pnpm visual:capture --help
pnpm visual:capture --list
pnpm visual:capture assistant-markdown-code
pnpm visual:capture appearance-settings
pnpm visual:capture appearance-settings --state characters
pnpm visual:capture assistant-markdown-code --state hover --theme light
pnpm visual:capture inline-links --state hover --theme dark
pnpm visual:capture browser-shared-chat --width 1440 --height 900
pnpm visual:capture browser-shared-chat --width 1440 --height 900
pnpm visual:capture browser-vscode --width 1440 --height 900
pnpm visual:capture vscode-terminal --state top --capture window --width 1440 --height 1000
pnpm visual:capture vscode-terminal --state bottom --capture window --width 1440 --height 1000
```

The command builds Cake before launching it. **Electron captures default to slim output**: no Swift compilation/toolchain probing or speech-asset downloads, and no native helpers left over from a previous full build. Browser scenarios build both `out/server` and `out/browser`. Only when a scenario genuinely needs bundled local native speech, opt into `CAKE_BUILD_MODE=full pnpm visual:capture <scenario>`. Use `--no-build` only when those assets are already current. Each run creates isolated temporary `CAKE_HOME` and explicitly sets `PI_CODING_AGENT_DIR` beneath it (plus Electron user-data for desktop scenarios) and removes them after success or failure. Browser scenarios use seeded Pi transcript and project files with a real server; `browser-vscode` requires the installed `/opt/homebrew/bin/code-server` and fails clearly rather than substituting a fake editor.

`screen-capture-overlay` captures the real hidden native overlay against a synthetic still (never the user's desktop). Its `default`, `destination`, `new-session`, and `annotate` states cover the compact movable strip, sidebar-style destination popup, per-Project new-chat choice, and target-first arrows. Use the default region capture; whole-window capture targets the owner Cake window.

Named scenarios define their own fixture, readiness checks, allowed states, interactions, and capture region. Add scenarios under `scripts/visual-capture/`; do not add an arbitrary selector/action command language. The `inline-links` scenario covers artifact, workspace, website, and session links in prose, with `default` and `hover` states.

Useful deterministic controls include:

- `--theme light|dark`
- `--width` and `--height` for the Electron renderer or Chromium browser viewport
- `--capture region|window` for Electron's scenario-owned region or full app content (browser scenarios always capture the full viewport). Full-window Electron captures composite the real captures of visible native WebContentsViews at their actual bounds and paint order, so embedded VS Code and Browser Mode are included.
- `--output <file.png>` or `--output-dir <directory>`

By default, PNGs are written beneath `.visual-captures/`, which is ignored by Git. Use a tracked location only when intentionally creating a reviewed fixture or baseline.

## Output contract

A successful run prints a short path summary followed by one stable line beginning with `VISUAL_CAPTURE_RESULT `. The remainder of that line is JSON containing schema version, scenario, state, captured PNG dimensions, absolute output path, MIME type, and SHA-256 checksum. This lets agents and automation consume the result without scraping the human summary.

A failed build, fixture setup, readiness check, interaction, or screenshot exits nonzero and identifies the scenario/state and intended file. Generated captures remain ordinary workspace PNG files: always display them inline in chat with Markdown image syntax such as `![Screenshot](.visual-captures/capture.png)`, never as plain clickable links. The harness does not depend on artifact presentation.
