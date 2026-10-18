import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
import type { UiPart } from "../../../contracts/conversations/session-contract";
import { withoutTerminalDocumentation } from "./pi-documentation";

type ContextPart = Extract<UiPart, { kind: "context" }>;
type SourceGroup = "system" | "tools" | "skills" | "worktree" | "instructions";
const sourceGroups = ["system", "tools", "skills", "worktree", "instructions"] as const;
const sourceTitles = {
  system: "System",
  tools: "Tools",
  skills: "Skills",
  worktree: "Worktree",
  instructions: "AGENTS.md",
} as const;

/** Pi's current tool declarations, without executable handlers or Cake metadata. */
export function runtimeSystemTools(session: Pick<AgentSession, "agent">): Tool[] {
  return session.agent.state.tools.map(({ name, description, parameters, constrainedSampling }) => {
    const tool: Tool = { name, description, parameters };
    if (constrainedSampling !== undefined) tool.constrainedSampling = constrainedSampling;
    return tool;
  });
}

function sectionBody(name: string, text: string): string {
  const opening = `<${name}>\n`;
  const closing = `\n</${name}>`;
  return text.startsWith(opening) && text.endsWith(closing)
    ? text.slice(opening.length, -closing.length)
    : text;
}

function splitPrompt(prompt: string) {
  const sections: Record<string, string | null> = {};
  let content = "";
  let offset = 0;
  for (const match of prompt.matchAll(/^<([a-z][a-z0-9_-]*)>\n[\s\S]*?^<\/\1>/gm)) {
    const preceding = prompt.slice(offset, match.index).trim();
    if (offset === 0 && preceding) sections.preamble = preceding;
    else if (preceding) content += `${content ? "\n\n" : ""}${preceding}`;
    sections[match[1]!] = match[0];
    offset = match.index + match[0].length;
  }
  content += prompt.slice(offset);
  return { content: content.trim(), sections };
}

function sourceGroup(name: string): SourceGroup {
  if (name === "tools" || name === "skills") return name;
  if (name === "worktree_instructions" || name === "fork_worktree" || name === "fork_paths")
    return "worktree";
  if (name === "project_context") return "instructions";
  return "system";
}

function toolContext(tools: readonly unknown[], label = "Tool declarations"): string {
  return `## ${label}\n\n\`\`\`json\n${JSON.stringify(tools, null, 2)}\n\`\`\``;
}

function projectPromptSections(
  content: string,
  sections: Record<string, string | null>,
  baseId: string,
  declarations: readonly string[] = [],
): ContextPart[] {
  const groups = {
    system: content ? [content] : [],
    tools: new Array<string>(),
    skills: new Array<string>(),
    worktree: new Array<string>(),
    instructions: new Array<string>(),
  } satisfies Record<SourceGroup, string[]>;
  for (const [name, value] of Object.entries(sections)) {
    if (value === null) {
      groups[sourceGroup(name)].push(`Removed system prompt section ${JSON.stringify(name)}.`);
      continue;
    }
    const body = sectionBody(name, value);
    if (name === "project_context") {
      let offset = 0;
      for (const match of body.matchAll(
        /<project_instructions path="([^"]+)">\n[\s\S]*?\n<\/project_instructions>/g,
      )) {
        groups.system.push(body.slice(offset, match.index));
        groups.instructions.push(`## \`${match[1]}\`\n\n${match[0]}`);
        offset = match.index + match[0].length;
      }
      groups.system.push(body.slice(offset));
    } else if (name === "addendum") {
      // Only explicit worktree boundaries carry worktree provenance. Other additions
      // (Cake, session, user, and extension guidance) remain together in System.
      let offset = 0;
      for (const match of body.matchAll(
        /^<worktree_instructions>\n[\s\S]*?^<\/worktree_instructions>/gm,
      )) {
        groups.system.push(body.slice(offset, match.index));
        groups.worktree.push(match[0]);
        offset = match.index + match[0].length;
      }
      groups.system.push(body.slice(offset));
    } else groups[sourceGroup(name)].push(value);
  }
  groups.tools.push(...declarations);
  return sourceGroups.flatMap((key) => {
    const text = groups[key]
      .map((value) => value.replace(/^Project-specific instructions and guidelines:\s*/, "").trim())
      .filter(Boolean)
      .join("\n\n");
    return text
      ? [{ id: `${baseId}-system-prompt-${key}`, kind: "context", title: sourceTitles[key], text }]
      : [];
  });
}

/** Group the live prompt without changing Pi's model-facing instructions. */
export function projectRuntimeSystemPrompt(
  prompt: string,
  baseId = "runtime",
  tools: readonly Tool[] = [],
): ContextPart[] {
  const { content, sections } = splitPrompt(prompt);
  return projectPromptSections(content, sections, baseId, tools.length ? [toolContext(tools)] : []);
}

/** Apply the same source groups to stored baselines and instruction/tool deltas. */
export function projectSystemContext(message: unknown, baseId: string, content: string): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const parsed = splitPrompt(content);
  const rawSections = Reflect.get(message, "sections");
  if (typeof rawSections === "object" && rawSections !== null)
    for (const [name, value] of Object.entries(rawSections))
      if (typeof value === "string" || value === null) parsed.sections[name] = value;
  const declarations: string[] = [];
  for (const [field, label] of [
    ["toolsAdded", "Tool declarations"],
    ["toolsRemoved", "Tools removed"],
  ] as const) {
    const tools = Reflect.get(message, field);
    if (Array.isArray(tools) && tools.length) declarations.push(toolContext(tools, label));
  }
  return projectPromptSections(parsed.content, parsed.sections, baseId, declarations);
}

/** Compare only Cake's terminal-doc adaptation as equivalent; retain all other instruction changes. */
function comparableInstructions(text: string): string {
  return text.replace(/^<docs>\n[\s\S]*?^<\/docs>/gm, withoutTerminalDocumentation);
}

/** Disposable display state, seeded from Pi on reopen; it never changes model context. */
export function createSystemContextProjector(messages: readonly unknown[] = []) {
  const sections = new Map<string, string | null>();
  const project = (message: unknown, baseId: string, content: string): UiPart[] => {
    if (typeof message !== "object" || message === null) return [];
    const rawSections = Reflect.get(message, "sections");
    const changes: Record<string, string | null> = {};
    if (typeof rawSections === "object" && rawSections !== null) {
      for (const [name, value] of Object.entries(rawSections)) {
        if (typeof value !== "string" && value !== null) continue;
        const previous = sections.get(name);
        if (
          previous !== value &&
          !(
            name === "docs" &&
            typeof previous === "string" &&
            typeof value === "string" &&
            comparableInstructions(previous) === comparableInstructions(value)
          )
        )
          changes[name] = value;
        sections.set(name, value);
      }
    }
    return projectSystemContext({ ...message, sections: changes }, baseId, content);
  };
  for (const message of messages)
    if (
      typeof message === "object" &&
      message !== null &&
      Reflect.get(message, "role") === "system"
    )
      project(message, "seed", "");
  return project;
}

/** Suppress equivalent full instruction baselines, retaining tool changes and partial patches. */
export function withoutRuntimeSystemPrompt(
  parts: readonly UiPart[],
  prompt: string,
  tools: readonly Tool[] = [],
): UiPart[] {
  const runtimeParts = projectRuntimeSystemPrompt(prompt, "runtime", tools);
  const runtimeInstructions = runtimeParts.filter((part) => part.title !== "Tools");
  const groups = new Map<string, ContextPart[]>();
  for (const part of parts) {
    if (part.kind !== "context") continue;
    const boundary = part.id.lastIndexOf("-system-prompt");
    if (boundary < 0) continue;
    const groupId = part.id.slice(0, boundary);
    const group = groups.get(groupId) ?? [];
    group.push(part);
    groups.set(groupId, group);
  }
  const redundantIds = new Set<string>();
  for (const group of groups.values()) {
    const instructions = group.filter((part) => part.title !== "Tools");
    if (
      runtimeInstructions.length === 0 ||
      instructions.length !== runtimeInstructions.length ||
      !runtimeInstructions.every((runtime) =>
        instructions.some(
          (part) =>
            runtime.title === part.title &&
            comparableInstructions(runtime.text) === comparableInstructions(part.text),
        ),
      )
    )
      continue;
    for (const part of group)
      if (
        runtimeParts.some(
          (runtime) =>
            runtime.title === part.title &&
            comparableInstructions(runtime.text) === comparableInstructions(part.text),
        )
      )
        redundantIds.add(part.id);
  }
  return parts.filter((part) => !redundantIds.has(part.id));
}
