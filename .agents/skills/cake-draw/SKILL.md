---
name: cake-draw
description: Explain ideas visually in Cake Draw through short, conversational whiteboard steps. Use when the user asks to draw, diagram, sketch, explain visually, or think together on a Cake Draw board. Pair meaningful canvas changes with concise explanation and adapt the picture to follow-up questions.
compatibility: Requires Cake's cake tool with Draw operations.
---

# Cake Draw

Explain at a shared whiteboard, not through a slide deck. Draw a little, say what matters, then build on it. The unit is an explanation step, not a drawing operation.

## Start with the point

- Identify the relationship the user needs to understand. Draw only when space, connections, containment, sequence, or contrast can make it clearer than prose alone.
- Choose a visual that serves that point: a flow for dependencies, boundaries or containment for ownership, aligned alternatives for comparison, or before/after for a change. Do not default to a flowchart for everything.
- Apply the **visual delta test** before drawing: the canvas must communicate at least one relationship that would be slower or harder to grasp from the same labels as prose. Use position, connection, direction, containment, scale, or contrast to carry meaning. A title followed by labeled cards, a list of facts in boxes, or prose arranged vertically fails this test and should remain chat text instead.
- Start with the smallest useful picture. For the first guided step, prefer 2–3 primary shapes and one visually encoded relationship; avoid decorative frames, redundant connectors, and styling passes. Do not first draw an agenda, taxonomy, or paragraphs in boxes unless their spatial arrangement itself explains something.
- Distinguish verified facts from hypotheses and illustrative examples. A confident-looking diagram is not evidence.

## Start drawing without protocol discovery

The skill contains the common Draw protocol on purpose. Use these known calls first; do **not** request the `draw` topic index or `*.help` before an ordinary explanation. Protocol discovery is a recovery path for an uncommon operation or a validation failure, not startup work.

Cake Draw is normally already foregrounded when this skill is invoked. Inspect the open board with:

```json
{ "command": "draw.read", "input": { "scope": "viewport" } }
```

`scope` may instead be `selection` when the user's selection is the subject, or `page` when off-screen context matters. `boardId` is optional for the open board.

For a simple connected explanation, start immediately with `draw.flow`:

```json
{
  "command": "draw.flow",
  "input": {
    "nodes": [
      { "id": "shape:request", "text": "Request" },
      { "id": "shape:service", "text": "Service" },
      { "id": "shape:result", "text": "Result" }
    ],
    "direction": "down",
    "connect": true
  }
}
```

Use stable, descriptive `shape:<id>` IDs. `direction` is `down` or `right`; `connect` defaults to true. Add a real ownership boundary with `"frame":{"id":"shape:runtime","title":"Runtime"}`. Extend the board without moving existing content by adding:

```json
"placement":{"relativeTo":"shape:service","side":"right","gap":100,"align":"center"}
```

For the common “owned region plus external dependency” picture, use one `draw.apply` call. Operations run in order, so later operations may connect or style shapes created earlier in the same call:

```json
{
  "command": "draw.apply",
  "input": {
    "operations": [
      {
        "type": "flow",
        "nodes": [
          { "id": "shape:ui", "text": "UI" },
          { "id": "shape:service", "text": "Service" }
        ],
        "direction": "down",
        "connect": true,
        "frame": { "id": "shape:app", "title": "Application" }
      },
      {
        "type": "flow",
        "nodes": [{ "id": "shape:external", "text": "External authority" }],
        "placement": {
          "relativeTo": "shape:app",
          "side": "right",
          "gap": 120,
          "align": "center"
        },
        "connect": false
      },
      {
        "type": "connect",
        "id": "shape:service-to-external",
        "fromId": "shape:service",
        "toId": "shape:external",
        "text": "adapter boundary",
        "fromPort": "right",
        "toPort": "left",
        "routing": "orthogonal"
      },
      {
        "type": "style",
        "ids": ["shape:ui", "shape:service"],
        "style": {
          "strokeColor": "#2563eb",
          "backgroundColor": "#dbeafe",
          "fill": "solid",
          "roundness": "round"
        }
      },
      {
        "type": "style",
        "ids": ["shape:external"],
        "style": {
          "strokeColor": "#15803d",
          "backgroundColor": "#dcfce7",
          "fill": "solid",
          "roundness": "round"
        }
      }
    ]
  }
}
```

Useful targeted follow-ups through `draw.apply` are:

```json
{
  "command": "draw.apply",
  "input": { "operations": [{ "type": "select", "ids": ["shape:service"] }] }
}
```

```json
{
  "command": "draw.apply",
  "input": {
    "operations": [
      { "type": "style", "ids": ["shape:service"], "style": { "strokeWidth": 4, "opacity": 1 } }
    ]
  }
}
```

```json
{
  "command": "draw.apply",
  "input": {
    "operations": [
      {
        "type": "connect",
        "id": "shape:a-to-b",
        "fromId": "shape:a",
        "toId": "shape:b",
        "routing": "orthogonal"
      }
    ]
  }
}
```

Use `draw.frame` when existing unframed shapes need a boundary:

```json
{
  "command": "draw.frame",
  "input": {
    "id": "shape:system-boundary",
    "title": "System boundary",
    "ids": ["shape:a", "shape:b"]
  }
}
```

Trust successful mutation receipts for simple additions and automatic fitting. Call `draw.read` again only when user edits, selection, or uncertain board context matter. Request an exact operation's `.help` only if these recipes do not cover the needed action or a live call reports that the protocol changed.

A topology-changing edit to an existing diagram requires one visual verification pass. This includes inserting an intermediary node, replacing connectors, rebuilding a frame, moving a connected node across the composition, or adding several routed connectors. Render the complete page—not merely the current viewport—after the mutation:

```json
{ "command": "draw.render", "input": { "scope": "page" } }
```

Inspect for shape overlap, connector crossings, labels sitting on shapes or other labels, awkward long routes, clipping, and a misleading camera position. Make at most one targeted corrective layout pass, then render again only if that correction changed routing or there is concrete doubt that it worked. Do not present a topology-changing step based only on mutation bounds.

During a guided explanation, prefer adding a separate detail stage or inset beside or below the stable overview. Restructure the existing overview only when the relationship itself must change; preserving the user's spatial orientation is more important than making every new point part of one compact graph.

## Choose the interaction contract

- Requests to explain, teach, walk through, or help the user understand something in Draw start a guided explanation by default. “In detail” describes depth, not permission to deliver every step in one turn.
- For a guided explanation, deliver one meaningful visual step with a short explanation and stop your turn. Wait for “continue,” the guide action bar's **Continue** action, or a substantive user response before advancing. Ordinary chat remains available alongside the action bar.
- Only an explicit request for a finished diagram or the entire explanation in one response selects a one-shot deliverable. Do not infer that exception from a broad topic, a request for detail, or the absence of the words “step by step.”
- A user asking to stop pauses the guide. A user discussing the skill or criticizing the interaction is asking about the method, not implicitly asking to resume the explanation or create controls. Address that request first.

## Draw a thing, say a thing

1. Make one coherent visual change that uses the canvas: establish a dependency with an arrow, show ownership with containment or bounded regions, trace a consequence through a path, place alternatives side by side, or reveal a before/after transformation. Never substitute a stack of text-bearing boxes for a relationship.
2. Pair it with one or two short sentences that state the implication or direct attention to the encoded relationship. Do not duplicate the diagram's labels as a prose list; if the spoken explanation works equally well without the picture, improve the visual or skip drawing that point.
3. Build on the same picture only as far as the current step needs. In a guided explanation, stop after that step; commentary between several tool calls in one turn is not interactive pacing. A step may need several drawing operations, but should teach only one relationship or consequence.

Do not ask permission for every shape, add artificial delays, or end every step with a question. End the turn when the point lands; the controls and ordinary chat let the user choose what happens next. For an explicitly requested one-shot walkthrough, use a few coherent stages with commentary between them. A finished-diagram request can be fulfilled directly.

## Keep a shared place to think

- On a follow-up, inspect the current board or selection. Treat "why this?" or "what if we move it?" as a reason to work on that part, not restart the explanation.
- Preserve orientation: keep existing positions, identities, and user annotations where practical. Prefer targeted edits over replacing the whole diagram.
- Guide attention with restrained emphasis or selection. Use zoom only when needed for legibility; avoid repeated camera jumps. Do not imply a temporary pointer exists if the tools only offer persistent styling.
- Give color a consistent meaning and accompany it with labels or structure. Remove your obsolete emphasis when focus changes without overwriting user edits.
- For alternatives, keep the original visible when comparison matters. Do not clear unrelated work or overwrite user drawings to make room.

## Add the predefined guide action bar

For every guided Draw explanation, mount Cake's predefined `action-bar` Session Plugin after the first successful, verified drawing step. Do not generate custom React and do not look up the plugin protocol first; call the known preset directly:

```json
{
  "command": "plugins.present",
  "input": {
    "plugin": {
      "id": "draw-guide",
      "title": "Draw guide",
      "preset": "action-bar",
      "initialState": {
        "label": "Current topic",
        "actions": [
          {
            "id": "continue",
            "label": "Continue",
            "primary": true,
            "message": "Continue with one meaningful Draw step, then update the draw-guide label and progress if present."
          },
          {
            "id": "explain",
            "label": "Explain this",
            "message": "Clarify the current Draw point or selection without advancing the guide."
          },
          {
            "id": "done",
            "label": "Done",
            "message": "Remove the draw-guide plugin using plugins.delete. Preserve the Draw board."
          }
        ]
      }
    }
  }
}
```

- Replace `title` and `label` with concise topic-specific text. Keep the stable ID `draw-guide` unless the session genuinely needs multiple independent guides.
- If the number of steps is known, add `"progress": { "current": 1, "total": N }` to `initialState`. After each completed step, call `plugins.patch` with only changed top-level fields, for example `{"id":"draw-guide","patch":{"label":"Failure boundary","progress":{"current":2,"total":4}}}`. Omitted actions and user visibility are preserved. The patch is shallow: supply both progress fields when changing progress.
- The action messages are ordinary visible user messages. A click does not itself advance progress or remove the plugin; perform the requested Draw work first, then update the state.
- When the user chooses **Done** or asks to stop permanently, call:

```json
{
  "command": "plugins.delete",
  "input": { "id": "draw-guide" }
}
```

- Removing controls must not clear the board. If the known preset call fails because the live protocol changed, then inspect `cake` command `plugins` and recover from the current schema.

## Use Cake's current tools

- Use the embedded fast-start calls and recipes above for ordinary work. Request the compact `draw` index or one exact `*.help` schema only for recovery, a protocol change, or an operation not covered here; never load all schemas speculatively.
- Use `draw.read` at the start of an explanation, when the user's selection or edits matter, or when board context is uncertain. Do not reread before every sequential step when your own recent mutations already establish the context. Open Draw when requested or needed for an agreed visual explanation, not merely because this skill loaded. If the board is unavailable, follow the tool's recovery guidance.
- Prefer `draw.flow` for incremental flows: supply stable `shape:<id>` node IDs and short text; measured sizing, typography, spacing, and arrows are automatic. Default direction is down for a narrow pane. Use an optional frame to encode real containment, not decoration. Place the next whole stage relative to an existing node or frame; Cake uses its live bounds without moving existing content. Use `draw.frame` to enclose existing unframed shapes and internal connectors without manual rectangle geometry or layer ordering. Frames are native, editable, one-shot containment—not continuous layout constraints.
- Use `draw.mermaid` for complete supported structured diagrams, with a stable diagram ID. Named replacement is for deliberate region revision, not every explanation step; it can disrupt layout.
- Use `draw.apply` for freeform composition and targeted changes. Keep each call to one visible stage within the advertised operation limit. Create nodes before connecting them; prefer relative placement over unnecessary coordinate arithmetic. Keep shape labels short; put detailed explanation in chat, not inside large boxes.
- Plan for the Draw pane rather than the whole application window, using already-known viewport context when available instead of measuring again. Prefer a compact vertical or stacked composition in a narrow pane. Keep labels to one or two short lines and explanatory prose in chat.
- Mutation receipts include resulting composition bounds and per-shape layout. Use them instead of rereading geometry before the next stage. The harness automatically fits the complete changed composition without enlarging beyond 100%; styling alone does not move the camera. Trust that automatic fit for ordinary guided steps. Use `draw.read` or explicit `zoom-to` only when the returned geometry, a user report, or the composition itself gives a concrete reason to suspect clipping.
- Optimize for conversational speed, not screenshot-perfect output. Do not call `draw.render` after every simple additive step. Render the complete page after topology-changing edits to an existing composition, and render when the layout is unusually dense, meaning depends on precise routing or overlap, the user asks for a polished result, or there is specific evidence that the board is unreadable. Use viewport rendering only when investigating a viewport-specific problem.
- Accept small imperfections—slightly uneven spacing, non-ideal connector routes, modestly small text, or extra blank space—when the explanation remains understandable. Do not undo and redraw merely to polish them. Prefer one quick targeted correction only when a defect changes the meaning or makes a primary label unreadable.
- Present the step promptly after a successful mutation. Verification must not become a blocking ritual: rely on the mutation receipt and automatic fitting for simple compositions, and reserve rollback for clearly broken or misleading output. If a correction would interrupt the teaching rhythm more than the defect does, continue and improve the layout only if the user requests it.
- Use only supported actions. Do not claim narration and drawing are synchronized playback, that a user edit automatically starts a turn, or that you can see changes you have not inspected.

## Example rhythm

For an illustrative system, not a claim about the user's code:

- Show two services connected to one database. Say: "Both services depend on the same database. Separate services don't give us separate failure boundaries here."
- If the user asks what happens during an outage, emphasize the database and both dependency paths in place. Say: "If this database goes down, both services lose access to their data."
- If they propose separate databases, adapt or compare the picture. Explain the changed failure boundary and any relevant new tradeoff rather than continuing a prewritten tour.

The test: did the picture make a relationship easier to understand, and did the words direct attention to it?
