import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { UiPart } from "../../../ipc/session-contract";

/** Present Pi's instruction and tool changes separately, never as a transcript JSON blob. */
export function projectSystemContext(message: unknown, baseId: string, content: string): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const parts: UiPart[] = [];
  const sections: Record<string, string | null> = {};
  const rawSections = Reflect.get(message, "sections");
  if (typeof rawSections === "object" && rawSections !== null)
    for (const [name, value] of Object.entries(rawSections))
      if (typeof value === "string" || value === null) sections[name] = value;
  const text = getSystemMessageText({
    role: "system",
    content,
    sections,
    timestamp: 0,
  });
  if (text)
    parts.push({ id: `${baseId}-system-prompt`, kind: "context", title: "System prompt", text });
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

/** The live prompt already discloses identical instructions; keep changes and removed history. */
export function withoutRuntimeSystemPrompt(parts: readonly UiPart[], prompt: string): UiPart[] {
  return parts.filter(
    (part) =>
      !(
        part.kind === "context" &&
        part.id.endsWith("-system-prompt") &&
        part.origin !== "compacted" &&
        part.text === prompt
      ),
  );
}
