# macOS distribution

The first distribution target is Apple Silicon, macOS 14 or newer. Cake ships as
`Cake-<version>-mac-arm64.dmg`, with a drag-to-Applications layout. No Apple
Developer account, Developer ID certificate or notarization credentials are used.

## Install and update

Download a DMG from the public [GitHub Releases page](https://github.com/melnikov-s/cake/releases),
open it, and drag **Cake** into **Applications**. For an update, quit Cake first
and replace the existing app. Do not delete Cake's data directories.

These builds are **ad-hoc signed, not Developer ID signed or notarized**. Ad-hoc
signing satisfies local code-signature requirements; it does not establish a
trusted publisher or eliminate Gatekeeper/download warnings. macOS may block the
first launch and require an explicit **Open Anyway** approval in **System Settings
→ Privacy & Security**, followed by another confirmation. Organizational policy
may prevent approval entirely. Cake does not disable Gatekeeper, remove quarantine
or bypass these checks. Downloaded-app first launch must be checked on a real Mac;
a local unquarantined build passing tests is not that check.

Packaged Apple Silicon builds check for updates once at launch and notify when a
newer stable version exists. **Cake → Check for Updates…** checks on demand and
shows errors, including when no release has been published yet. Launch checks
fail quietly when offline. Downloads open externally; Cake never replaces itself,
installs an update or restarts automatically. There is no periodic polling.
Notifications can be disabled by macOS; the menu check remains available.

The feed is the `latest-mac-arm64.json` asset on the latest public, non-prerelease
GitHub Release in `melnikov-s/cake`. It only becomes live after the first release
is published. Releases use stable `major.minor.patch` versions, tagged `v<version>`;
prereleases are not part of this initial distribution channel. Metadata contains
`version`, the version-specific DMG `downloadUrl`, and `sha256`. Only the matching
DMG URL in this repository is accepted. `SHA256SUMS` is also published for manual
verification; Cake does not download or checksum the DMG itself.

## Runtime and data

Electron (including its Node runtime), production npm dependencies, renderer and
browser-sharing assets, Pi documentation/examples, WASM, esbuild, node-pty and its
spawn helper, and the native dictation/speech engines and resources are bundled.
They remain outside ASAR so executable helpers and runtime resource loading work
without a checkout or a `node_modules` symlink. Non-code resources are not signed
as executable files. Local speech recognition/output models are still optional,
explicit downloads in Settings; the small speech detector ships in the app.

Launching Cake needs no source checkout, pnpm, standalone Node, Swift, Python or
Xcode. Working on projects still needs Git and the project's own tools. Apple's
`/usr/bin/git` may require Command Line Tools; standalone Git is another option.
The embedded VS Code surface on macOS requires an external `code-server`
installation (for example `brew install code-server`), or a configured server path.
Optional Pi/widget package installation uses external npm; MCP servers and project
commands may need their own Node/Python/etc. Install these separately and make them
available to subprocesses, using explicit executable paths where a Finder launch
has a more limited PATH than your terminal. A provider account/API key and network
access are needed for cloud models, independently of app distribution.

Application identity stays **Cake**. Existing locations are unchanged:

- `~/Library/Application Support/Cake`: Electron window/device settings and local speech data.
- `~/.cake`: Cake state, artifacts and permanent Cake Chat SQLite history.
- Pi's existing agent directory (normally `~/.pi/agent`): credentials, settings and regular chats.

Existing `CAKE_HOME`, `PI_CODING_AGENT_DIR` and other supported overrides still apply.
Replacing only `Cake.app` does not move, copy or reset these directories. Normal
storage migrations still run. Permissions such as microphone, screen recording
and Accessibility remain controlled by macOS and may need approval again after an
ad-hoc-signed replacement. In-app `cake://` references keep their existing routing;
Cake does not currently register an OS-level `cake://` URL handler. Browser-to-app
deep links are not introduced by this packaging change.

## Build and release

On an Apple Silicon build machine, install Node 24, pnpm 10.17.1 and Swift 6.2+
(Xcode 26.2 in CI). Then:

```sh
pnpm install --frozen-lockfile
pnpm dist:mac
CAKE_PACKAGED_APP=dist/mac-arm64/Cake.app pnpm test:packaged
```

`dist:mac` runs the full build, including native assets. `package:mac` packages an
already-built full `out/`; it rejects missing native helpers rather than silently
shipping a slim build. Local packaging always uses `--publish never` and ad-hoc
signing, even if signing identities are present. Outputs are under `dist/`:

- `mac-arm64/Cake.app`
- `Cake-<version>-mac-arm64.dmg`
- `latest-mac-arm64.json` and `SHA256SUMS`

The packaged smoke test copies the app outside the checkout, audits bundle
symlinks/signatures/resources, launches hidden with a minimal PATH, exercises
esbuild, PTY and helper launch, edits a real setting, quits, replaces the copied
app and relaunches against the same isolated data. It makes no model requests,
does not use the microphone, and never overwrites `/Applications/Cake.app`.
It does not verify native speech inference, first-launch Gatekeeper approval,
TCC permission prompts or compatibility on the oldest supported macOS.

[The release workflow](../../.github/workflows/release-mac.yml) builds on the public
GitHub `macos-15` Apple Silicon runner. It verifies the DMG checksum, mounts it
without opening Finder, and runs the standalone smoke test against the mounted app.
Manual dispatch builds downloadable Actions artifacts only. A pushed tag matching
`package.json` builds, tests and publishes a
public GitHub Release with the DMG and metadata. Only the publish job receives
`contents: write`; it uses GitHub's automatic job token. No custom secrets or Apple
credentials are required. The workflow must be on the repository's default branch
for manual dispatch. Update the package version before each subsequent release;
never reuse or replace a published version.

Before enabling live delivery, a maintainer must land the changes and deliberately
push the matching release tag. Implementing or locally testing this workflow does
not publish a release. If the repository becomes private or releases move to a
different host, choose a public download/metadata host and update the feed and URL
contract; do not embed a GitHub access token in Cake.
