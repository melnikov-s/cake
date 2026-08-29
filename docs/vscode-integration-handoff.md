# VS Code Integration Handoff

## Product direction

Cake’s embedded VS Code experience should feel like one connected agent workspace rather than a separate editor placed inside the application.

Cake has two complementary modes:

- **Agent mode** is the full project conversation and agent workflow.
- **IDE mode** places embedded VS Code on the left and the authoritative Cake chat drawer on the right.

VS Code owns source browsing, editing, Git changes, and native diffs. Cake owns conversations, agent activity, reviews, and contextual workflows. Users should be able to move between code and conversation without copying paths, line numbers, snippets, diagnostics, or change descriptions manually.

The following phases extend that foundation.

## Phase one — Structured source locations

Create a consistent source-location experience throughout Cake and VS Code.

A source location should be able to identify:

- A workspace-relative file
- A single line or exact line range
- Start and end columns when relevant
- A symbol when the reference concerns a named declaration
- The document version when stale-location detection matters

Cake should recognize and open common references such as:

- `src/main.ts`
- `src/main.ts:880`
- `src/main.ts:880:12`
- `src/main.ts#L880-L892`

Selecting a source reference anywhere in Cake should enter IDE mode if necessary, open the file in VS Code, center the relevant code, select the exact range, and briefly highlight it. References from assistant messages, tool activity, work logs, changes, review threads, and artifacts should behave consistently.

The experience should make “show me where that is” a dependable application-wide capability.

## Phase two — Agent change navigation

Make agent edits easy to find through the existing authorities:

- VS Code's Source Control view shows the complete working tree and native Git diffs.
- Cake's conversation work logs preserve historical per-turn diffs.
- Cake’s edit and tool activity links directly to the relevant changed range.

Cake does not maintain a parallel working-tree browser or project transcript-derived
change status into the editor.

## Phase three — Conversational guided navigation

Allow Cake and the agent to direct the user to a source location while explaining it in the ordinary project conversation.

The Cake gateway should expose a progressively disclosed `vscode` topic with a focused `vscode.open` operation. The operation accepts a workspace-relative file and an optional exact line and column range. Calling it should enter IDE mode if necessary, open the file, center the range, select it, and briefly highlight it. Agent-facing line and column numbers are one-based even though Cake’s internal VS Code location contract is zero-based.

This supports requests such as:

- “Show me what changed.”
- “Walk me through this implementation.”
- “Explain how this request moves through the application.”
- “Show me why this test fails.”
- “Take me through the important parts of this review.”

The explanation remains in the authoritative Cake chat. For a multi-location walkthrough, the agent opens and explains one location, then invites the user to say **next** when ready. The next user turn advances the walkthrough through another `vscode.open` call. The conversation itself preserves the sequence and allows requests such as “back” or “show me that again.”

Do not introduce a saved tour object, dedicated tour drawer, editor comment, CodeLens, or Previous/Next controls in this phase. Those richer projections should be added only if concrete use demonstrates that conversational navigation is insufficient. The VS Code operation coordinates visible editor navigation; ordinary filesystem tools remain authoritative for reading and editing source.

## Phase four — Cake annotations in VS Code

Project Cake’s existing code conversations and review state into VS Code.

Relevant code locations should be able to display:

- Gutter markers
- Inline or CodeLens-style indicators
- Reply counts
- Open, pending, answered, and resolved states
- A short hover preview of the discussion

Selecting an annotation should open the authoritative Cake conversation in the right-hand drawer and reveal its full history. Resolving or reopening the conversation in Cake should update its VS Code annotation.

VS Code annotations are navigation and status projections. They should not create a second chat transcript or a competing reply experience inside VS Code.

## Phase five — Explicit editor context

Give users convenient, controlled ways to include their current VS Code context in a conversation.

The Cake composer should be able to offer context such as:

- Current selection
- Active file
- Visible lines
- Open tabs
- Enclosing symbol
- Current diagnostics

These items should appear as understandable attachments or context chips. Users should be able to inspect and remove them before sending a message.

Cake may use editor awareness to offer relevant context, but it should not silently send everything visible or open in VS Code to the model. Inclusion should remain explicit and legible to the user. The current selection attachment is created only by a non-empty, user-originated VS Code selection and sends only its workspace-relative path and line range. It does not send selected or nearby source text. Cake-directed source reveals are presentation-only decorations and must never become conversation context.

The IDE drawer should update appropriately as the active editor changes without unexpectedly replacing a draft or changing the active conversation.

## Phase six — Diagnostics, symbols, and tests

Connect Cake to the semantic information already available in VS Code.

Users should be able to initiate workflows such as:

- **Ask Cake About This Diagnostic**
- **Fix This Error**
- **Explain This Symbol**
- **Review This File**
- **Explain This Failing Test**
- **Find and Explain Callers**
- **Compare Implementations**

These workflows should carry richer context than copied source text. Depending on the request, Cake should understand the relevant symbol, definition, references, implementations, related diagnostics, test identity, and associated source locations.

Results should remain connected to the editor: explanations should link back to exact code, proposed or completed fixes should remain visible in conversation work logs and VS Code Source Control, and multi-location explanations should be available as guided tours.

## Intended result

When these phases are complete, Cake and VS Code should behave as two coordinated views of the same work:

1. The user encounters code in VS Code.
2. Cake receives explicit, structured context through a supported workflow.
3. The user chats in the IDE drawer without leaving the editor.
4. The agent explains or changes the project.
5. VS Code reveals and highlights the exact affected locations.
6. Cake guides the user through changes, diagnostics, symbols, tests, and discussions.
7. The user can return to full Agent mode at any time without losing conversation or editor context.

The goal is not to reproduce an IDE inside Cake or reproduce Cake inside VS Code. The goal is a single connected workflow in which VS Code is the source workspace and Cake is the conversational and agent layer.
