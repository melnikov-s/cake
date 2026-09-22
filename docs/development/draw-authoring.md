# Compact Draw authoring

Discover `draw` for the command index, then `draw.flow.help` (or any command plus
`.help`) for one exact schema. Ordinary no-input commands keep their execution
semantics; help never opens or mutates a board.

## A guided step

```json
{
  "command": "draw.flow",
  "input": {
    "nodes": [
      { "id": "shape:request", "text": "Request" },
      { "id": "shape:service", "text": "Service" }
    ],
    "frame": { "id": "shape:runtime", "title": "Runtime" }
  }
}
```

Nodes default to a vertical connected flow with measured labels, readable
sans-serif type, and consistent spacing. `direction: "right"` makes a row;
`connect: false` removes automatic edges. Frames are optional and should encode
real containment, not decorate every step.

Extend the picture with another small flow and
`placement: { relativeTo: "shape:runtime", side: "below" }`. Cake places the
**whole new stage** against live bounds and slides it outward past obstructions.
It never relayouts old nodes. Use `draw.apply` for cross-stage connections and
individual edits. Receipts include stable IDs, resulting composition bounds, and
per-shape layout, avoiding an extra read just to place the next stage. Bounds cover
the entire composition; layout lists at most 200 roots with `layoutTruncated: true`
when capped. Read when user edits, selection, or uncertain context matter.

`draw.frame` fits a new native frame around existing unframed IDs, including their
bound labels. Include internal arrows in the IDs. Moving a frame moves its
members; deleting it leaves the members. Frames cannot nest. Containment is
editable native membership, not a persistent constraint or a second Cake graph.
Mermaid remains the complete-diagram path, not an incremental scene reconciler.

After completing a step, patch only guide fields that changed:

```json
{
  "command": "plugins.patch",
  "input": {
    "id": "draw-guide",
    "patch": { "label": "Failure boundary", "progress": { "current": 2, "total": 4 } }
  }
}
```

The patch is shallow and atomic in main-owned application state. Omitted actions
and visibility survive. Nested objects/arrays replace as units; null is a value.
The entire merged preset must validate. Clicks still send ordinary user messages;
they do not optimistically advance progress. There is deliberately no Draw-specific
guide state machine. Temporary spotlight/presenter overlays are deferred; selection
remains available without pretending persistent styling is transient.

## Ownership and verification

Flow/frame use the existing Schema-validated Apply invocation and its visible
session, resolved-session, serialization, cancellation, playback, checkpoint,
and durable-flush rules. Layout lives in the renderer editor adapter, where live
native geometry and text measurement exist. Each structural operation is one
visible playback stage. Flows reveal their measured nodes in order and then their
connections within the shared bounded playback budget, without relayout between
animation frames. No agent-side coordinate compiler, new transport, Store state,
persisted layout specification, or compatibility API is introduced.

Coverage includes tool decoding/routing, a real DrawStore + native adapter workflow
with controlled persistence, frame membership and user-edit preservation, atomic
plugin patches, and an isolated Electron test with an actual pointer edit between
stages. `pnpm visual:capture draw-composition` captures the compact native flow.
The repository-scoped [cake-draw skill](../../.agents/skills/cake-draw/SKILL.md)
contains the updated conversational authoring guidance.

## Size comparison

Measured generated protocol text and minified JSON payloads (characters, **not
provider-token counts**):

| Case                                                             | Before | After | Reduction |
| ---------------------------------------------------------------- | -----: | ----: | --------: |
| Initial Draw discovery                                           | 77,865 | 2,101 |     97.3% |
| Discovery plus exact flow help                                   | 77,865 | 4,697 |     94.0% |
| Two-node flow, equivalent measured dimensions/type and one arrow |    553 |   123 |     77.8% |
| Guide label/progress update, same three skill actions            |    544 |   127 |     76.7% |

The baseline flow uses create, create-relative, connect, and shared style operations;
it excludes a manual frame, so containment savings are additional. At a rough
four-characters-per-token proxy, discovery plus flow help drops from ~19.5k to
~1.2k tokens. Actual tokenizer savings vary; this is a size proxy, not a billing
benchmark. Compact layout receipts cost more than IDs alone but avoid much larger
scene/style reads. Protocol tests enforce small discovery and flow-help budgets.
