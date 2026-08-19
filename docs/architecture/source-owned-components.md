# Source-owned renderer components

Cake uses the shadcn/ui source-ownership model: component source is copied into
`src/renderer/components`, reviewed, adapted to Cake contracts, and maintained
as application code. Registry packages are not runtime component authorities.

## Import record

| Cake component                                                                                   | Source                                                        | Revision                                   | License    | Cake changes                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ai-elements/confirmation.tsx`                                                        | Vercel AI Elements `packages/elements/src/confirmation.tsx`   | `0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b` | Apache-2.0 | Replaced `ToolUIPart` with Cake's `ConfirmationState`; removed AI SDK, Next.js, and upstream monorepo dependencies; adapted semantics and styling for the Electron extension-dialog path.                                                                                                                                  |
| `components/ai-elements/{conversation,message,markdown,code,reasoning,tool,source,composer}.tsx` | Vercel AI Elements counterparts under `packages/elements/src` | `0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b` | Apache-2.0 | Reduced to Cake's S1 conversation needs; replaced all AI SDK parts and hooks with Cake-owned props; removed AI SDK, upload, scroll, Next.js, and transport dependencies. The Markdown wrapper now delegates safe static/streaming rendering to Streamdown with its Shiki, KaTeX, and Mermaid plugins; raw HTML is skipped. |

The adaptations retain useful compositional and accessibility patterns while
accepting only Cake-owned props. Their browser dependency surface is React,
Cake's source-owned button and class-name utility, and the explicitly documented
Streamdown Markdown renderer and plugins. They do not add Electron, AI SDK,
transport, provider, or network dependencies.

## Import convention

For every future registry-derived component:

1. Copy only the component and the smallest set of reviewed primitives it
   actually needs.
2. Record the source project, upstream path, full commit SHA, and license in
   this file.
3. Put an attribution header in Apache-derived source and describe material
   modifications in that header.
4. Replace upstream application and AI SDK types with Cake-owned presentation
   contracts before integrating the component.
5. Audit browser dependencies for Node access, network behavior, and CSP impact.
6. Add a focused component test and exercise cross-process behavior in the real
   Electron smoke path when the component participates in IPC.
