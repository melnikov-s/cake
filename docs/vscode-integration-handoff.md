# VS Code Integration Handoff

## Product direction

Cake’s embedded VS Code experience should feel like one connected agent workspace rather than a separate editor placed inside the application.

Cake has two complementary modes:

- **Agent mode** is the full project conversation and agent workflow.
- **IDE mode** places embedded VS Code on the left and the authoritative Cake chat drawer on the right.

VS Code owns source browsing and editing. Cake owns conversations, agent activity, changes, reviews, and contextual workflows. Users should be able to move between code and conversation without copying paths, line numbers, snippets, diagnostics, or change descriptions manually.

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

## Phase two — Agent change visibility

Make agent edits immediately understandable inside VS Code.

After an agent changes files, IDE mode should help the user review those edits by providing:

- Temporary highlighting for changed ranges
- Cake markers beside changed lines
- **Previous Change** and **Next Change** navigation
- A way to open the complete change as a native VS Code diff
- Direct navigation from Cake’s edit and tool activity to the relevant changed range
- A clear indication of which changes belong to the current agent turn

The user should be able to move through the agent’s work without searching for files or comparing the transcript with the editor manually. Reviewed changes may be dimmed or cleared so that unreviewed work remains easy to identify.

## Phase three — Add a VS Code selection to project chat

Support two distinct actions for selected code:

- **Ask Cake About Selection** starts or opens a contextual code conversation in the IDE drawer.
- **Add Selection to Project Chat** attaches the selection to the main project conversation.

Adding a selection to project chat should preserve the file and exact range as visible context rather than pasting an anonymous code block. The project-chat drawer should show a source attachment that the user can inspect, remove, or reopen in VS Code.

This gives users a choice between a focused discussion tied to one code location and a broader request that may involve the whole project or multiple selected locations.

## Phase four — Guided code and change tours

Allow Cake and the agent to guide the user through a sequence of source locations.

Tours should support requests such as:

- “Show me what changed.”
- “Walk me through this implementation.”
- “Explain how this request moves through the application.”
- “Show me why this test fails.”
- “Take me through the important parts of this review.”

A tour should have a title and an ordered set of steps. Each step should contain a source location, a short heading, and an explanation. The Cake drawer should present the explanation and **Previous**/**Next** controls while VS Code opens and highlights the current location.

Users should be able to leave a tour, return to ordinary project chat, and reopen the tour while it remains relevant. A change tour should be easy to start directly from completed agent work.

## Phase five — Cake annotations in VS Code

Project Cake’s existing code conversations and review state into VS Code.

Relevant code locations should be able to display:

- Gutter markers
- Inline or CodeLens-style indicators
- Reply counts
- Open, pending, answered, and resolved states
- A short hover preview of the discussion

Selecting an annotation should open the authoritative Cake conversation in the right-hand drawer and reveal its full history. Resolving or reopening the conversation in Cake should update its VS Code annotation.

VS Code annotations are navigation and status projections. They should not create a second chat transcript or a competing reply experience inside VS Code.

## Phase six — Explicit editor context

Give users convenient, controlled ways to include their current VS Code context in a conversation.

The Cake composer should be able to offer context such as:

- Current selection
- Active file
- Visible lines
- Open tabs
- Enclosing symbol
- Current diagnostics

These items should appear as understandable attachments or context chips. Users should be able to inspect and remove them before sending a message.

Cake may use editor awareness to offer relevant context, but it should not silently send everything visible or open in VS Code to the model. Inclusion should remain explicit and legible to the user.

The IDE drawer should update appropriately as the active editor changes without unexpectedly replacing a draft or changing the active conversation.

## Phase seven — Diagnostics, symbols, and tests

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

Results should remain connected to the editor: explanations should link back to exact code, proposed or completed fixes should appear through the agent-change review experience, and multi-location explanations should be available as guided tours.

## Intended result

When these phases are complete, Cake and VS Code should behave as two coordinated views of the same work:

1. The user encounters or selects code in VS Code.
2. Cake receives explicit, structured context.
3. The user chats in the IDE drawer without leaving the editor.
4. The agent explains or changes the project.
5. VS Code reveals and highlights the exact affected locations.
6. Cake guides the user through changes, diagnostics, symbols, tests, and discussions.
7. The user can return to full Agent mode at any time without losing conversation or editor context.

The goal is not to reproduce an IDE inside Cake or reproduce Cake inside VS Code. The goal is a single connected workflow in which VS Code is the source workspace and Cake is the conversational and agent layer.
