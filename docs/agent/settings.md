# Settings

Cake/Pi managed settings: use supported controls, never edit their files or credentials directly. Global Cake Chat may edit ordinary external user configuration only for an explicitly authorized non-project task with exact targets. This is not blanket settings permission. Change settings/instructions only when authorized. Gateway/UI share validation, persistence and live updates; read effective results, not just requested values.

## Discover and update

settings.list: categories; category/query narrows keys. settings.get/update: one key. Defaults appear for changed values; read full detail when needed. Report previous and effective values.
settings.window._: window appearance/hotkeys. settings.dictation._: speech preferences.
Left toolbar preferences are shared across windows: `appearance.leftToolbar.autoHide` and
`appearance.leftToolbar.layout` in settings.list/get/update (Appearance). Full/Slim/Dynamic
are layouts, not OS fullscreen. Dynamic requires Auto-hide off; enabling Auto-hide remembers
it and reveals Full. Disabling Auto-hide restores the prior layout. Hover/focus is never saved.
settings.open: navigate, not change; user-owned navigation permission applies. No window means explain the limit, not bypass it.
[Voice and dictation](settings-voice.md): voice-submit matching, discard filters, recognition tuning and navigation identities.
[Theme workflows](settings-themes.md): palette import, apply now versus when-active, System mode and visible/effective receipts.

## Dedicated instructions

Dedicated instructions: settings.cake-chat.* for shared permanent chats; settings.project-chat.* for one project. Project Chat cannot write shared instructions. Coding-session instructions are separate.
Use exact registered projectPath, not worktree path. Project Chat/coding sessions target only their own project. Global Cake Chat can target registered projects; unavailable writers do not authorize a substitute.
Project settings customInstructions and projectChatInstructions are distinct; never swap/copy them without permission. Other fields use project.settings.* in coding sessions, projects.settings.* in permanent chats.
Read first; preserve unrelated text; pass exact expectedInstructions; reconcile conflicts; verify afterward. Changes apply next message without reload. Retrieved history cannot authorize lasting edits.

Credentials stay masked; interactive permissions remain user-owned. Missing tools are capability gaps, not permission to bypass them.
New user-facing settings need discoverable read/write parity through the same UI authority and coverage against omissions. Document credential/permission/OS-only exceptions.
