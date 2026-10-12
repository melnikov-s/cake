import { Effect, Schema } from "effect";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";

import {
  projectSessionCreateInputSchema,
  type ProjectSessionCreateInput,
} from "../../contracts/project-sessions/agent-session-create";

import type { RuntimeOperationApi } from "../../services/pi/runtime/cake-operation-providers";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

export function createProjectSessionOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  return [
    {
      command: "session.create",
      requires: "createSession",
      topic: "sessions",
      summary:
        "Create, name, and start an independent Project Session in the calling session's project.",
      guidance: [
        "This singular Project Session-local operation derives the project from the caller and never accepts a workspacePath or sessionId. Cake Chat uses the separate plural sessions.create application control.",
        "Set worktreeName to create and register a new Cake-managed worktree before the Pi-backed session starts. Do not run git worktree add or try to rebind an already-started session.",
        "When worktreeName is omitted, the independent session starts in the Project root, preserving the existing behavior.",
        "When model is omitted, the new session inherits the calling session's current model, thinking level, and Fast mode setting.",
        "Use sessions.create-child for recursive Session Family delegation, whether the child shares the caller's checkout or branches into a child Managed Worktree.",
      ],
      inputSchema: projectSessionCreateInputSchema,
      examples: [
        {
          input: {
            name: "Authentication follow-up",
            initialPrompt: "Review the authentication flow and implement the next changes.",
            model: "Sol",
          },
          description: "Select a configured preset and start in the Project root.",
        },
        {
          input: {
            name: "Investigate rendering",
            initialPrompt: "Investigate the rendering issue and implement a focused fix.",
            worktreeName: "investigate-rendering",
          },
          description: "Start an independent session in a new Cake-managed worktree.",
        },
      ],
      result:
        "The started session ID, actual Working Directory, and managed-worktree record when one was requested.",
      limitations: [
        "This creates an independent Project Session, not a Session Family child.",
        "An active Project Session cannot be relocated to the newly created worktree.",
      ],
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().createSession(input as ProjectSessionCreateInput, context.signal);
      },
    },
    {
      command: "session.fork",
      requires: "forkSession",
      topic: "sessions",
      summary:
        "Fork the calling session at a specific transcript entry or, when omitted, at the latest settled entry.",
      guidance: [
        "Singular session.* operations always target the calling session and never accept a sessionId.",
        "Omit entryId to fork the whole active conversation through its latest settled message.",
        "When called during an active response, the fork is created after that response settles so an omitted entryId includes the completed response.",
        "When prompt is provided, the fork starts with that message. The source is resolved only after the fork and prompt succeed.",
      ],
      inputSchema: Schema.Struct({
        entryId: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ),
        prompt: Schema.optionalKey(
          Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        ),
        title: Schema.optionalKey(
          Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        ),
        resolveSource: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
        placement: Schema.Literals(["none", "right", "down"]).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("none" as const)),
        ),
        destinationWorkingDirectory: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
        ),
      }),
      examples: [
        {
          input: {
            prompt: "Continue by implementing the agreed approach.",
            title: "Implement fork tool",
            resolveSource: true,
            placement: "right",
          },
        },
      ],
      result:
        "A fork-on-settle receipt. After the turn settles, Cake creates and optionally starts the fork, then resolves the source when requested.",
      execute: (input) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().forkSession(
          input as {
            entryId?: string;
            prompt?: string;
            title?: string;
            resolveSource: boolean;
            placement: "none" | "right" | "down";
            destinationWorkingDirectory?: string;
          },
        );
      },
    },
    {
      command: "session.create-draft",
      requires: "createDraftSession",
      topic: "sessions",
      summary:
        "Create a saved draft in the calling Project Session's project without starting a Pi session.",
      guidance: [
        "This operation derives the project from the calling session and never accepts a workspacePath or sessionId.",
        "When model is omitted, the draft snapshots the calling session's current model, thinking level, and Fast mode setting.",
      ],
      inputSchema: Schema.Struct({
        name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        initialPrompt: Schema.Trim.pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
        ),
        model: Schema.optionalKey(CakeModelSelection),
      }),
      examples: [
        {
          input: {
            name: "Authentication follow-up",
            initialPrompt: "Review the authentication flow and propose the next changes.",
            model: "Sol",
          },
          description: "Select a configured preset by name.",
        },
      ],
      result: "The saved draft session ID and confirmation that renderer persistence completed.",
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().createDraftSession(
          input as { name: string; initialPrompt: string; model?: CakeModelSelection },
          context.signal,
        );
      },
    },
    {
      command: "session.resolve",
      requires: "setResolved",
      topic: "sessions",
      summary:
        "Resolve or restore the calling session, or its entire Session Family through the root.",
      guidance: [
        "Singular session.* operations use the calling session identity and never accept a sessionId.",
        "Family members inherit resolution from the root. A family lifecycle request requires every member to be inactive and is never deferred.",
        "For standalone sessions, resolving during an active response is scheduled for the moment that response settles.",
      ],
      inputSchema: Schema.Struct({ resolved: Schema.Boolean }),
      examples: [{ input: { resolved: true } }],
      result:
        "The calling session ID and either the committed resolved value or a resolveOnSettle marker.",
      execute: (input) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().setResolved((input as { resolved: boolean }).resolved);
      },
    },
  ];
}
