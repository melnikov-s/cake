---
name: architecture-diagrams
description: Create rich, persistent architecture diagrams in Cake. Use when the user asks for an architectural overview, system map, dependency diagram, process-boundary diagram, trust-boundary diagram, or an explorable diagram of a codebase.
---

# Architecture diagrams

Create substantial architecture explanations through the unified delegated React widget path. Before presenting one, inspect enough of the project to support every important fact and relationship. Distinguish verified structure from interpretation in both the brief and readable fallback.

## Choose the right output

- Use `widgets.present` for a substantial, reusable, explorable architecture or dependency view.
- Use inline Mermaid for a small diagram that is clearest directly in the conversation.
- Use ordinary prose or a table when interaction and a custom visual do not improve understanding.

Call `cake widgets` to inspect the current operation schema before creating a widget.

## Brief requirements

Give the specialist a semantic explanation brief rather than React source, graph JSON, or pixel coordinates. Include:

1. The intended audience and the question the explanation should answer.
2. One clear abstraction level and a suggested reading path.
3. Verified facts, meaningful boundaries, and relationships, with uncertainty labeled.
4. Workspace-relative source references for important code-backed claims.
5. Bounded local data needed to render the explanation.
6. Useful interactions such as selection, filtering, progressive disclosure, or comparison—only when they help the audience.
7. A concise, mandatory Markdown fallback that remains understandable without the visual.

The specialist chooses the best visual form. It may compose prose and accessible controls with React Flow, optional ELK layout, SVG/D3, or ordinary React. For connected systems, React Flow and ELK are available inside the widget compiler; describe relationships and boundaries rather than prescribing coordinates. Prefer a purposeful view over an exhaustive network.

## Quality check

Before calling the tool, verify:

- Every important claim and relationship is supported by inspected evidence.
- Process, ownership, deployment, or trust boundaries are explicit when relevant.
- Cross-boundary relationships say what moves or depends across the boundary.
- Source references are workspace-relative and useful to a maintainer.
- The brief does not demand invented precision or a specific graph DSL.
- The fallback explains the main boundaries and flow on its own.

## Example

```json
{
  "command": "widgets.present",
  "input": {
    "widget": {
      "id": "runtime-overview",
      "title": "Runtime overview",
      "brief": "For maintainers, explain how the sandboxed renderer communicates with Electron main and where Pi runtime and persistence authority live. Show the renderer/main trust boundary, label the validated RPC and projection relationships, and provide selectable source-backed details. Verified sources: src/renderer/main.ts, src/main/main.ts, src/services/pi, src/services/storage, and docs/architecture/cake-architecture.md. Prefer a clear reading path over an exhaustive dependency graph; choose React Flow/ELK or another visual form as appropriate.",
      "data": {
        "facts": [
          "The renderer is sandboxed and owns presentation projections.",
          "Electron main owns Pi runtimes, filesystem access, and persistence."
        ]
      },
      "fallback": {
        "markdown": "The sandboxed renderer receives validated projections from Electron main. Main owns Pi runtimes and persistent storage."
      }
    }
  }
}
```

After presentation, summarize the view briefly in chat and refer to it as a widget artifact. Do not paste generated source into the user-facing response.
