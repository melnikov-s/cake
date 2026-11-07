# Theme workflows

For saved Cake/embedded-editor themes, not [widget theme consumption](widget-theme.md).

themes.list returns saved bundled/custom IDs and effective appearance; themes.read {choice} returns exact palette/syntax data.
themes.add saves a custom theme without applying it. Supply name and theme with type:light|dark and VS Code hex color roles:

```json
{
  "name": "Warm night",
  "theme": {
    "type": "dark",
    "colors": {
      "editor.background": "#191322",
      "editor.foreground": "#f4e6d5",
      "button.background": "#ed8a27"
    }
  }
}
```

Optional tokenColors/semanticTokenColors retain syntax styling. For JSON/JSONC with includes, supply name, entry and files instead; includes resolve only within supplied data, never extension code.

For an authorized create-and-apply request, add then themes.apply with returned theme.choice and application:"now".
now preserves appearance when that mode is already visible (including System); otherwise switches Light/Dark so the choice is visible.
application:"when-active" changes only that mode's slot, preserving appearance/System and the opposite slot. Check visible before claiming the theme is on screen.
Read state.effective and state.appearance; use settings.window.update for appearance alone. Report actual effective values.

Themes use the connected caller window's durable catalog, shared by Settings, Cake and embedded editors, not a global backend store. Missing desktop binding is explicit failure, not permission to edit files/click around or bypass authorization.
