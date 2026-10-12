import type { UiPart } from "../../../ipc/session-contract";

type ContextPart = Extract<UiPart, { kind: "context" }>;
const piSectionNames = new Set(["preamble", "tools", "rules", "docs"]);

function sectionBody(name: string, text: string): string {
  const opening = `<${name}>\n`;
  const closing = `\n</${name}>`;
  return text.startsWith(opening) && text.endsWith(closing)
    ? text.slice(opening.length, -closing.length)
    : text;
}

/** Split only Pi's rendered section boundaries; opaque/forced prompt text stays disclosed. */
export function projectRuntimeSystemPrompt(prompt: string, baseId = "runtime"): ContextPart[] {
  const sections: Record<string, string> = {};
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
  // With no sections, do not claim provenance for a custom or forced prompt
  // that Pi treats as opaque. Preserve extension text outside the sections too.
  return projectPromptSections(content.trim(), sections, baseId);
}

function projectPromptSections(
  content: string,
  sections: Record<string, string | null>,
  baseId: string,
): ContextPart[] {
  const parts: ContextPart[] = [];
  const add = (key: string, title: string, text: string) => {
    if (text.trim())
      parts.push({
        id: key === "content" ? `${baseId}-system-prompt` : `${baseId}-system-prompt-${key}`,
        kind: "context",
        title: title.slice(0, 512),
        text,
      });
  };
  add("content", "System prompt", content);
  const piText = Object.entries(sections)
    .filter(([name, value]) => piSectionNames.has(name) && typeof value === "string")
    .map(([, value]) => value)
    .join("\n\n");
  add("pi", "Pi system prompt", piText);
  for (const [name, value] of Object.entries(sections)) {
    if (value === null || piSectionNames.has(name)) continue;
    const body = sectionBody(name, value);
    if (name === "addendum") {
      // Cake marks source boundaries while assembling the addendum. Do not infer
      // provenance from headings or split arbitrary user Markdown on blank lines.
      const titles = new Map([
        ["cake_system_prompt", "Cake system prompt"],
        ["session_instructions", "Session instructions"],
        ["worktree_instructions", "Worktree instructions"],
        ["project_investigation", "Project investigation instructions"],
      ]);
      let offset = 0;
      let index = 0;
      for (const match of body.matchAll(
        /^<(cake_system_prompt|session_instructions|worktree_instructions|project_investigation)>\n[\s\S]*?^<\/\1>/gm,
      )) {
        add(`additional-${index++}`, "Additional instructions", body.slice(offset, match.index));
        add(match[1]!, titles.get(match[1]!)!, match[0]);
        offset = match.index + match[0].length;
      }
      add(`additional-${index}`, "Additional instructions", body.slice(offset));
    } else if (name === "project_context") {
      let remainder = "";
      let offset = 0;
      let index = 0;
      for (const match of body.matchAll(
        /<project_instructions path="([^"]+)">\n[\s\S]*?\n<\/project_instructions>/g,
      )) {
        remainder += body.slice(offset, match.index);
        const path = match[1]!;
        const filename = path.split(/[\\/]/).at(-1) ?? path;
        add(`file-${index++}`, `${filename} · ${path}`, match[0]);
        offset = match.index + match[0].length;
      }
      remainder += body.slice(offset);
      // This is Pi's container label, not a separate instruction source.
      remainder = remainder.replace(/^Project-specific instructions and guidelines:\s*/, "");
      add("project-context", "Project context", remainder);
    } else {
      const title =
        name === "skills"
          ? "Skills"
          : name === "cwd"
            ? "Working directory"
            : `System section · ${name}`;
      add(`section-${name}`, title, value);
    }
  }
  return parts;
}

/** Present Pi's instruction sources and tool changes separately. */
export function projectSystemContext(message: unknown, baseId: string, content: string): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const sections: Record<string, string | null> = {};
  const rawSections = Reflect.get(message, "sections");
  if (typeof rawSections === "object" && rawSections !== null)
    for (const [name, value] of Object.entries(rawSections))
      if (typeof value === "string" || value === null) sections[name] = value;
  const parts: UiPart[] = [
    ...projectRuntimeSystemPrompt(content, baseId),
    ...projectPromptSections("", sections, baseId),
  ];
  for (const [name, value] of Object.entries(sections))
    if (value === null)
      parts.push({
        id: `${baseId}-section-removed-${parts.length}`,
        kind: "context",
        title: `System section removed · ${name}`.slice(0, 512),
        text: `Removed system prompt section ${JSON.stringify(name)}.`,
      });
  for (const [field, label] of [
    ["toolsAdded", "Tool"],
    ["toolsRemoved", "Tool removed"],
  ] as const) {
    const tools = Reflect.get(message, field);
    if (!Array.isArray(tools)) continue;
    tools.forEach((tool, index) => {
      if (typeof tool !== "object" || tool === null) return;
      const name = Reflect.get(tool, "name");
      parts.push({
        id: `${baseId}-${field}-${index}`,
        kind: "context",
        title: `${label} · ${typeof name === "string" ? name : "unnamed"}`.slice(0, 512),
        text: `\`\`\`json\n${JSON.stringify(tool, null, 2)}\n\`\`\``,
      });
    });
  }
  return parts;
}

/** Suppress an identical full baseline, never an individual source-change patch. */
export function withoutRuntimeSystemPrompt(parts: readonly UiPart[], prompt: string): UiPart[] {
  const runtimeParts = projectRuntimeSystemPrompt(prompt);
  const groups = new Map<string, ContextPart[]>();
  for (const part of parts) {
    if (part.kind !== "context" || part.origin === "compacted") continue;
    const boundary = part.id.lastIndexOf("-system-prompt");
    if (boundary < 0) continue;
    const groupId = part.id.slice(0, boundary);
    const group = groups.get(groupId) ?? [];
    group.push(part);
    groups.set(groupId, group);
  }
  const redundantIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.length !== runtimeParts.length) continue;
    if (
      runtimeParts.every((runtime) =>
        group.some((part) => runtime.title === part.title && runtime.text === part.text),
      )
    )
      for (const part of group) redundantIds.add(part.id);
  }
  return parts.filter((part) => !redundantIds.has(part.id));
}
