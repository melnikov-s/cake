import { Schema } from "effect";
import { compactDiscoveryGuidance } from "../../contracts/agent/discovery-result-text";
import { AgentListInput } from "../../contracts/agent/agent-list-data";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  AgentProjectAddInput,
  AgentProjectInfoInput,
  AgentProjectRemoveInput,
  AgentProjectRenameInput,
  type CakeChatProjectControl,
} from "../../contracts/projects/agent-projects";
import {
  ProjectSettingsGetInput,
  ProjectSettingsUpdateInput,
} from "../../contracts/projects/project-settings-schema";

const projectResult =
  "The registered Project: exact path (use it verbatim as workspacePath or projectPath), display name, canonical projectChatId, addedAt, lastOpenedAt and whether the user has trusted its Pi resources.";

/** Cake Chat's Project registry: the registration, rename, removal and Project settings the sidebar offers. */
export function createCakeChatProjectOperations(
  control: CakeChatProjectControl,
): CakeOperationDefinition[] {
  return [
    {
      command: "projects.list",
      topic: "projects",
      summary:
        "List registered Projects with exact paths and canonical Project Chat messaging addresses.",
      guidance: [
        'Filter names/paths with query; use projects.info for trust and timestamps. Send directly with sessions.send { sessionId: projectChatId, text, delivery: "fyi" } for a passive update; no filesystem lookup or hashing is needed.',
        compactDiscoveryGuidance,
      ],
      inputSchema: AgentListInput,
      examples: [{}],
      result:
        "Compact path/name/projectChatId rows, total and next=N when another page exists. projectChatId is canonical and available before the chat is opened.",
      execute: (input, context) =>
        control.list(Schema.decodeUnknownSync(AgentListInput)(input), context.signal),
    },
    {
      command: "projects.info",
      topic: "projects",
      summary: "Inspect one registered Project by its exact path.",
      inputSchema: AgentProjectInfoInput,
      examples: [{ input: { path: "/Users/me/src/project" } }],
      result: projectResult,
      execute: (input, context) =>
        control.info(Schema.decodeUnknownSync(AgentProjectInfoInput)(input), context.signal),
    },
    {
      command: "projects.add",
      topic: "projects",
      summary:
        "Register an existing local directory as a Cake Project, like Open Project in the sidebar.",
      guidance: [
        "The directory must already exist. Getting the checkout there (clone, worktree, zone tree) is operational work: delegate it to an allowMutations worker first, then register the path it reports.",
        "Pass an absolute path; the name defaults to the directory's base name. Adding a path that is already registered returns that Project unchanged with alreadyRegistered: true; use projects.rename to change its name.",
        "The Project appears in the sidebar and app.state immediately. Use the returned path verbatim with sessions.create or subagents.start.",
        "Registration does not grant trust. If trusted is false, call projects.request-trust with the returned exact path to ask for explicit in-app approval before launching project workers. This also works for already registered Projects, without reopening the folder. Decline or cancellation is not approval; do not create dummy Pi resources or change defaultProjectTrust to force approval.",
      ],
      inputSchema: AgentProjectAddInput,
      examples: [
        { input: { path: "/Users/me/world/trees/agents" } },
        {
          input: { path: "/Users/me/src/website", name: "Website" },
          description: "Register with a custom display name.",
        },
      ],
      result: `${projectResult} alreadyRegistered reports whether it was registered before this call.`,
      limitations: [
        "Cake-managed worktrees cannot be registered; register their Project root instead.",
        "Cake keeps at most 200 registered Projects.",
      ],
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.add(
          await Schema.decodeUnknownPromise(AgentProjectAddInput)(input),
          context.signal,
        );
      },
    },
    {
      command: "projects.request-trust",
      topic: "projects",
      summary: "Ask the user to trust an exact registered Project in Cake, without reopening it.",
      guidance: [
        "Call after projects.add or projects.info reports trusted:false. Cake presents its own exact-path code-execution warning in the requesting chat's window; this operation cannot approve itself and accepts no approval flag.",
        "The tool returns the actual user decision, not an admission receipt. Only approved or already-trusted permits continuing an already-authorized build with sessions.create using project.path verbatim as workspacePath. Keep the authorized task, initialPrompt and resultDelivery in that subsequent launch; trust approval alone launches nothing and is not proof of worker execution or completion.",
        "On declined or cancelled, stop the launch handoff and report that no worker was launched. Do not retry approval unless the user asks. Creating or implementing a Project does not authorize its repository instructions, plugins or extensions.",
      ],
      inputSchema: AgentProjectInfoInput,
      examples: [{ input: { path: "/Users/me/src/project" } }],
      result: `decision is approved, declined, cancelled or already-trusted. ${projectResult}`,
      limitations: [
        "Requires a connected renderer for the requesting Cake Chat or Project Chat. No recipient is an error, never approval. The current conversation and navigation remain unchanged.",
      ],
      execute: (input, context) =>
        control.requestTrust(
          Schema.decodeUnknownSync(AgentProjectInfoInput)(input),
          context.signal,
        ),
    },
    {
      command: "projects.rename",
      topic: "projects",
      summary: "Change a registered Project's display name. Its path does not change.",
      inputSchema: AgentProjectRenameInput,
      examples: [{ input: { path: "/Users/me/world/trees/agents", name: "Agents zone" } }],
      result: projectResult,
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.rename(
          await Schema.decodeUnknownPromise(AgentProjectRenameInput)(input),
          context.signal,
        );
      },
    },
    {
      command: "projects.remove",
      topic: "projects",
      summary:
        "Remove a Project from Cake, like Remove Project in the sidebar. Files on disk are never touched.",
      guidance: [
        "Only remove a Project when the user explicitly asks. Cake stops its sessions' runtimes and terminals and forgets the Project; the directory and its Git state stay on disk.",
        "deleteSessions defaults to false, which keeps the Project's sessions on disk so re-adding the Project restores them. Set it to true only when the user explicitly asks to delete the sessions too; that is permanent.",
      ],
      inputSchema: AgentProjectRemoveInput,
      examples: [
        { input: { path: "/Users/me/world/trees/agents" } },
        {
          input: { path: "/Users/me/world/trees/agents", deleteSessions: true },
          description: "Also permanently delete the Project's sessions (only on explicit request).",
        },
      ],
      result: "The removed Project path and whether its sessions were deleted.",
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.remove(
          await Schema.decodeUnknownPromise(AgentProjectRemoveInput)(input),
          context.signal,
        );
      },
    },
    {
      command: "projects.settings.get",
      topic: "projects",
      summary: "Read every setting for one registered Project by its exact path.",
      guidance: [
        "Use the exact registered path from projects.list, never a Cake-managed worktree path.",
      ],
      inputSchema: ProjectSettingsGetInput,
      examples: [{ input: { projectPath: "/Users/me/src/project" } }],
      result: "The Project's path and every effective setting, defaults included.",
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.getSettings(
          await Schema.decodeUnknownPromise(ProjectSettingsGetInput)(input),
          context.signal,
        );
      },
    },
    {
      command: "projects.settings.update",
      topic: "projects",
      summary:
        "Patch settings for one registered Project by its exact path and return every committed setting.",
      guidance: [
        "Call projects.settings.get first. Only the fields in changes are written; unspecified settings stay unchanged. Read back with projects.settings.get before claiming success.",
        "Worktree fields: worktreeCreateCommand checks out {branchName} (empty runs git worktree add); worktreeSetupCommands run in each new worktree; worktreeRemoveCommand removes a checkout (empty runs git worktree remove); worktreeCommandTimeoutSeconds limits each of those commands (0 waits indefinitely); worktreeLanding is merge (Cake lands locally) or pull-request (landing happens outside Cake).",
        "customInstructions guide only coding Project Sessions; projectChatInstructions guide only that Project's permanent Project Chat. Never move or swap text between them without user authorization. For Project Chat guidance prefer settings.project-chat.get/update, which check expectedInstructions for conflicts.",
      ],
      inputSchema: ProjectSettingsUpdateInput,
      examples: [
        {
          input: {
            projectPath: "/Users/me/src/project",
            changes: { worktreeLanding: "pull-request", worktreeCommandTimeoutSeconds: 600 },
          },
        },
      ],
      result: "The Project's path and every committed setting.",
      limitations: ["Unknown setting names are rejected; nothing is written."],
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.updateSettings(
          await Schema.decodeUnknownPromise(ProjectSettingsUpdateInput)(input),
          context.signal,
        );
      },
    },
  ];
}
