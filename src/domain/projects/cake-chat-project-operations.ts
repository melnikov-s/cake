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

const projectResult =
  "The registered Project: exact path (use it verbatim as workspacePath or projectPath), display name, addedAt, lastOpenedAt and whether the user has trusted its Pi resources.";

/** Cake Chat's Project registry: the same registration, rename and removal the sidebar offers. */
export function createCakeChatProjectOperations(
  control: CakeChatProjectControl,
): CakeOperationDefinition[] {
  return [
    {
      command: "projects.list",
      topic: "projects",
      summary: "List a bounded page of registered Project names and exact paths.",
      guidance: [
        "Filter names/paths with query; use projects.info for trust and timestamps.",
        compactDiscoveryGuidance,
      ],
      inputSchema: AgentListInput,
      examples: [{}],
      result: "Compact path/name rows, total and next=N when another page exists.",
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
        "Registration does not trust the Project's Pi resources (extensions, skills, prompts); the user approves that in Cake when they open it.",
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
  ];
}
