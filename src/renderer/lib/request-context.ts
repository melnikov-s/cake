import { Predicate, Schema } from "effect";
import { jsonObjectSchema, type JsonValue } from "../../ipc/json-contract";

export interface RequestContextSection {
  title: string;
  value: JsonValue;
  defaultOpen?: boolean;
}

function messageSection(value: JsonValue): RequestContextSection {
  const message = Schema.is(jsonObjectSchema)(value) ? value : undefined;
  if (!message || !Predicate.isString(message.role)) return { title: "Message", value };
  const { role, ...fields } = message;
  const content = fields.content ?? fields.parts;
  const remaining = Object.entries(fields);
  const readable = remaining.length === 1 && content !== undefined ? content : fields;
  const text = Predicate.isString(content) ? content : JSON.stringify(content);
  const memory = role === "user" && text?.includes("<chat>") && text.includes("<current-time>");
  const title =
    role === "system"
      ? "Instructions"
      : role === "developer"
        ? "Developer instructions"
        : memory
          ? "Remembered conversation"
          : role === "user"
            ? "Your message"
            : role === "assistant" || role === "model"
              ? "Assistant"
              : role === "tool"
                ? "Tool result"
                : role;
  return { title, value: readable };
}

/** A readable projection of the captured body, never a transcript reconstruction.
 * Preserve message order, literal content and unknown fields; copying uses the original string. */
export function requestContextSections(value: JsonValue): RequestContextSection[] {
  const body = Schema.is(jsonObjectSchema)(value) ? value : undefined;
  if (!body) return [{ title: "Content", value }];
  const instructions: RequestContextSection[] = [];
  const messages: RequestContextSection[] = [];
  const tools: RequestContextSection[] = [];
  const parameters: Array<readonly [string, JsonValue]> = [];
  for (const [key, child] of Object.entries(body)) {
    if (["system", "instructions", "systemInstruction"].includes(key)) {
      instructions.push({ title: "Instructions", value: child });
    } else if (["messages", "input", "contents"].includes(key)) {
      if (Array.isArray(child)) messages.push(...child.map(messageSection));
      else messages.push({ title: "Your message", value: child });
    } else if (["tools", "toolConfig"].includes(key)) {
      tools.push({ title: "Tools", value: child, defaultOpen: false });
    } else {
      parameters.push([key, child]);
    }
  }
  const sections = [...instructions, ...messages, ...tools];
  if (parameters.length) {
    sections.push({
      title: sections.length ? "Parameters" : "Content",
      value: Object.fromEntries(parameters),
      defaultOpen: sections.length === 0,
    });
  }
  return sections.length ? sections : [{ title: "Content", value }];
}
