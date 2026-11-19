# Widget attachments

For placing existing widget instances in chat slots or Workspace tabs. [Widget authoring](widget-authoring.md) covers source and saved state.

## Attach

Create with `widgets.present` or `widgets.instantiate`, then attach the returned lineage:

```json
{
  "command": "widgets.attach",
  "input": {
    "id": "summary-panel",
    "lineageId": "conversation-summary",
    "target": { "kind": "global" },
    "slot": "right"
  }
}
```

Targets: `global`, `project-chats` (all durable Project Chats), `project-sessions` (all regular work sessions), or `{kind:"session",sessionId}`. These are categories across Cake, not all sessions in one project. Slots: `top`, `bottom`, `left`, `right`, and `tab`. The `tab` slot occupies a full Workspace pane beside To-dos/Sessions with the same applicability as chat edges: retain the attachment target, ID and lineage when moving. Only applicable tabs appear in the picker; hidden tabs retain their header and Show action. One tab attachment per widget lineage; reuse its ID rather than creating another. `order` is a zero-based position. Drag the header to an edge or Workspace; Enter on the header starts keyboard placement (arrows for edges, W for Workspace, Page Up/Down for order, Enter to place, Escape to cancel). The gear contains Hide/Show and Close. Hide releases the view without deleting saved state. Applicable tab views remain mounted and active when unselected or when the pane closes. Leaving applicability releases scoped views/subscriptions; returning restores saved state without broadening scope. Detaching a selected tab falls back to the last built-in Workspace view. Attachment is what lets backend runtimes and schedules run: once a widget has no attachments, its runtime stops and its schedules stay dormant until attached again. Close calls `widgets.detach {id}` and keeps saved state and schedule configuration. `widgets.attachments {}` lists current placements.

Broad attachments reuse one lineage/state/backend runtime through multiple disposable views. Independent data requires explicit `widgets.instantiate` with a new lineage ID. Closing a view destroys its iframe, timers and subscriptions—not its saved state or explicit background runtime/jobs. A surface must be open; scrolling offscreen does not destroy it. Widget code cannot attach itself or manage permissions. Agents can attach directly on user request.
