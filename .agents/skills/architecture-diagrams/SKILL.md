---
name: architecture-diagrams
description: Create rich, persistent architecture graph artifacts in Cake. Use when the user asks for an architectural overview, system map, dependency diagram, process-boundary diagram, trust-boundary diagram, or an explorable diagram of a codebase.
---

# Architecture diagrams

Create architecture diagrams as structured graph data rendered by Cake. Do not generate React, React Flow code, ELK coordinates, HTML, or a delegated widget for a graph that fits this format.

Before presenting a graph, inspect enough of the project to support every important node and edge. Distinguish confirmed structure from interpretation in node descriptions and the readable fallback.

## Choose the right output

- Use `artifacts.presentArchitecture` for a substantial, reusable, explorable architecture or dependency view.
- Use inline Mermaid for a small, disposable diagram that is clearest in the conversation.
- Use `widgets.present` only for a bespoke visualization, simulation, or interaction the architecture graph cannot represent.

Call `cake artifacts` to inspect the current operation schema before creating an artifact.

## Modeling rules

1. Pick one audience and one abstraction level. Do not mix packages, classes, infrastructure, and individual functions without a specific reason.
2. Prefer 5–30 nodes. Split a large system into multiple purposeful views rather than making one exhaustive graph.
3. Use short noun labels for nodes and short relationship labels for edges.
4. Use groups only for meaningful ownership, deployment, process, or trust boundaries—not decoration.
5. Select the closest node category: `interface`, `service`, `process`, `database`, `external`, or `module`.
6. Select the closest edge kind: `data`, `control`, `dependency`, or `event`.
7. Add a concise description when selection should reveal context that does not fit in the node label.
8. Add workspace-relative source locations for important code-backed nodes. Line and column positions are zero-based.
9. Do not provide pixel positions. Cake uses ELK to lay out the graph.
10. Always include a useful Markdown fallback that explains the main boundaries and flow without requiring the visual artifact.

## Direction

- `LR`: pipelines, request flows, layered runtime boundaries.
- `TB`: hierarchies, ownership trees, dependency stacks.
- `RL` or `BT`: use only when the domain convention makes the reverse flow clearer.

## Quality check

Before calling the tool, verify:

- Every edge endpoint names an existing node.
- Node, group, and edge IDs are unique; node and group IDs do not overlap.
- Every node group exists.
- Important process and trust boundaries are explicit.
- Cross-boundary edge labels explain what crosses the boundary.
- The diagram has a clear reading path and no speculative precision.
- The fallback is understandable on its own.

## Example

```json
{
  "command": "artifacts.presentArchitecture",
  "input": {
    "architecture": {
      "id": "runtime-overview",
      "title": "Runtime overview",
      "graph": {
        "direction": "LR",
        "groups": [{ "id": "electron", "label": "Electron" }],
        "nodes": [
          {
            "id": "renderer",
            "label": "Renderer",
            "category": "interface",
            "group": "electron",
            "description": "Sandboxed React UI and window-scoped state.",
            "source": { "path": "src/renderer/main.ts" }
          },
          {
            "id": "main",
            "label": "Main process",
            "category": "process",
            "group": "electron",
            "description": "Owns native and privileged services."
          }
        ],
        "edges": [
          {
            "id": "renderer-main",
            "source": "renderer",
            "target": "main",
            "label": "Effect RPC",
            "kind": "control"
          }
        ]
      },
      "fallback": {
        "markdown": "The sandboxed renderer communicates with the privileged Electron main process through validated Effect RPC."
      }
    }
  }
}
```

After presentation, summarize the view briefly in chat and refer to it as an artifact. Do not paste the full graph payload into the user-facing response.
