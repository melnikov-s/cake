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

- Discover the compact command index with `cake` command `draw`, then request only the needed schema with `draw.flow.help`, `draw.frame.help`, or another command plus `.help`. These are authoritative for limits and recovery; do not load all schemas for an ordinary step.
- Use `draw.read` at the start of an explanation, when the user's selection or edits matter, or when board context is uncertain. Do not reread before every sequential step when your own recent mutations already establish the context. Open Draw when requested or needed for an agreed visual explanation, not merely because this skill loaded. If the board is unavailable, follow the tool's recovery guidance.
- Prefer `draw.flow` for incremental flows: supply stable `shape:<id>` node IDs and short text; measured sizing, typography, spacing, and arrows are automatic. Default direction is down for a narrow pane. Use an optional frame to encode real containment, not decoration. Place the next whole stage relative to an existing node or frame; Cake uses its live bounds without moving existing content. Use `draw.frame` to enclose existing unframed shapes and internal connectors without manual rectangle geometry or layer ordering. Frames are native, editable, one-shot containment—not continuous layout constraints.
- Use `draw.mermaid` for complete supported structured diagrams, with a stable diagram ID. Named replacement is for deliberate region revision, not every explanation step; it can disrupt layout.
- Use `draw.apply` for freeform composition and targeted changes. Keep each call to one visible stage within the advertised operation limit. Create nodes before connecting them; prefer relative placement over unnecessary coordinate arithmetic. Keep shape labels short; put detailed explanation in chat, not inside large boxes.
- Plan for the Draw pane rather than the whole application window, using already-known viewport context when available instead of measuring again. Prefer a compact vertical or stacked composition in a narrow pane. Keep labels to one or two short lines and explanatory prose in chat.
- Mutation receipts include resulting composition bounds and per-shape layout. Use them instead of rereading geometry before the next stage. The harness automatically fits the complete changed composition without enlarging beyond 100%; styling alone does not move the camera. Trust that automatic fit for ordinary guided steps. Use `draw.read` or explicit `zoom-to` only when the returned geometry, a user report, or the composition itself gives a concrete reason to suspect clipping.
- Optimize for conversational speed, not screenshot-perfect output. Do not call `draw.render` after every step. Render the viewport only when the layout is unusually dense, the visual meaning depends on precise routing or overlap, the user asks for a polished result, or there is specific evidence that the board is unreadable.
- Accept small imperfections—slightly uneven spacing, non-ideal connector routes, modestly small text, or extra blank space—when the explanation remains understandable. Do not undo and redraw merely to polish them. Prefer one quick targeted correction only when a defect changes the meaning or makes a primary label unreadable.
- Present the step promptly after a successful mutation. Verification must not become a blocking ritual: rely on the mutation receipt and automatic fitting for simple compositions, and reserve rollback for clearly broken or misleading output. If a correction would interrupt the teaching rhythm more than the defect does, continue and improve the layout only if the user requests it.
- Use only supported actions. Do not claim narration and drawing are synchronized playback, that a user edit automatically starts a turn, or that you can see changes you have not inspected.

## Example rhythm

For an illustrative system, not a claim about the user's code:

- Show two services connected to one database. Say: "Both services depend on the same database. Separate services don't give us separate failure boundaries here."
- If the user asks what happens during an outage, emphasize the database and both dependency paths in place. Say: "If this database goes down, both services lose access to their data."
- If they propose separate databases, adapt or compare the picture. Explain the changed failure boundary and any relevant new tradeoff rather than continuing a prewritten tour.

The test: did the picture make a relationship easier to understand, and did the words direct attention to it?
