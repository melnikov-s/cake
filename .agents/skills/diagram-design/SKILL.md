---
name: diagram-design
description: Design, draw, and review clear technical diagrams, architecture maps, data-flow diagrams, sequence diagrams, and explanatory whiteboards. Use whenever creating or substantially revising a diagram in Cake Draw, Mermaid, Excalidraw, or Markdown.
compatibility: Cake Draw, Mermaid, and Markdown diagram workflows.
---

# Diagram Design

Create diagrams that answer a specific question for a specific audience. A diagram is not complete when shapes exist; it is complete when its rendered result communicates without narration.

## Mandatory workflow

1. **State the question privately before drawing.** Write one sentence: “This diagram answers: …”. If the request does not imply a clear question, ask the user before drawing.
2. **Identify the audience and takeaway.** Decide what the viewer should understand within five seconds and what detail they may inspect afterward.
3. **Choose a concrete visual story.** Prefer recognizable domain objects, real labels, and representative examples over symbolic IDs.
4. **Choose the diagram form from the relationship:**
   - Sequence diagram: time-ordered interactions between participants.
   - Flowchart: transformations, decisions, and pipelines.
   - Architecture map: ownership, boundaries, and dependencies.
   - State diagram: lifecycle and transitions.
   - Before/after storyboard: a product behavior or data transformation best explained with concrete examples.
   - Manual Cake Draw composition: UI-like examples, mixed explanatory panels, or layouts Mermaid cannot express cleanly.
5. **Sketch the hierarchy before details.** Establish title, 3–5 major regions, reading direction, and primary connections. Add implementation details only after the main story is legible.
6. **Draw in bounded stages.** In Cake Draw, keep each `draw.apply` to one visible stage and at most eight operations. Prefer `draw.mermaid` for diagrams it can lay out well; use `draw.apply` for concrete storyboards and targeted cleanup.
7. **Render and inspect the actual result.** Use `draw.render` at the viewing size. Never present an unreviewed diagram.
8. **Fix visible defects before responding.** At minimum inspect for crossed connectors, lines through text, clipped or wrapped labels, unclear starting point, excessive whitespace, low contrast, inconsistent terminology, and unreadable density.
9. **Run the standalone test.** A viewer unfamiliar with the implementation must be able to identify the question, reading order, major entities, and conclusion without accompanying prose.
10. **Report completion only after the rendered diagram passes review.** Do not describe defects as caveats; correct them.

## Composition rules

### One question, one takeaway

Use a question or claim as the title. The title should communicate why the diagram exists, not merely name the subsystem.

Good: “How does Cake keep old work logs visible without returning them to model context?”

Weak: “Tool compaction architecture”.

### Audience vocabulary

Use product and domain terms the viewer already knows. Spell out a concept before introducing an identifier. Avoid unexplained abbreviations such as `U1`, `A1`, `T1`, generic boxes such as “Manager”, or internal type names as primary labels.

When exact identifiers matter, place them in a secondary technical inset after the behavior is understandable.

### Concrete before abstract

For explanatory diagrams, begin with one representative example:

- “User: Investigate the rendering bug”
- “Assistant: I’ll inspect the transcript”
- “Work log: Read file · Search code · Run tests”

Then show how the system stores, transforms, or presents those recognizable objects. Concrete examples make structural differences visible without requiring a legend.

### Visual hierarchy

A useful default hierarchy is:

1. Question/title
2. One-sentence takeaway
3. Three or four numbered regions
4. Concrete cards or nodes
5. Small technical details or metadata

Do not give metadata, transport mechanics, and product outcomes equal visual weight.

### Reading direction

Use one dominant direction: left-to-right for pipelines and transformations, top-to-bottom for hierarchies and lifecycles. Branches may diverge, but should not force the eye to reverse direction.

### Connectors

- Every connector must encode a meaningful relationship.
- Do not run connectors through nodes, labels, or other connectors.
- Prefer short orthogonal or direct routes between adjacent regions.
- Put labels in whitespace, not over card contents.
- Remove arrows that merely restate obvious spatial order.
- When automatic connectors route poorly, replace them with explicitly positioned standalone arrows.

### Color

Use color semantically and consistently. Limit the palette to roughly four roles, for example:

- Gray: retained or historical source data
- Blue: active or current data
- Green: user-visible output
- Purple: model/runtime input
- Yellow: metadata, warning, or provenance

Color must reinforce labels, never replace them. Ensure the diagram remains understandable without color.

### Density

Prefer 3–5 major regions and concise labels. If a box needs paragraphs, split the story into steps or move detail into an inset. Do not compress a complete implementation spec into one canvas.

## Cake Draw guidance

- Read the current viewport or selection before editing an existing board.
- Preserve useful user-created shapes; delete obsolete agent-generated attempts when the user asks to start over.
- Use stable explicit IDs for manually created shapes so cleanup and targeted revisions are reliable.
- Use `draw.mermaid` only when its automatic layout fits the intended relationship. Do not force a storyboard or UI explanation into a sequence diagram merely because Mermaid is available.
- Use `draw.apply` for explanatory panels, concrete transcript examples, and precise placement.
- After Mermaid import, render it. If subgraph headings overlap, labels wrap poorly, or the result is excessively wide, replace or clean it rather than presenting it.
- Zoom to the finished composition after cleanup.

## Review checklist

Before presenting, answer yes to all applicable items:

- Does the title state the question or conclusion?
- Is the starting point obvious?
- Can the main takeaway be understood in five seconds?
- Are all terms understandable without a legend?
- Are concrete examples used where they would help?
- Is there one dominant reading direction?
- Are there no crossed connectors or lines through text?
- Are labels readable at the actual viewport size?
- Are colors consistent and accessible?
- Is implementation detail subordinate to the product story?
- Does the diagram distinguish source data, transformation, and output?
- Did I render and inspect the final revision?

If any answer is no, continue editing.

## Common failure modes

- Drawing before deciding what question the diagram answers
- Replacing understandable language with compact identifiers
- Using Mermaid’s diagram type as the conceptual model
- Showing every internal step at equal prominence
- Treating a generated layout as finished without rendering it
- Explaining a bad diagram in prose instead of correcting it
- Asking the viewer to mentally decode branches, colors, or abbreviations
- Presenting an implementation pipeline when a concrete before/after example would be clearer
