import { Schema, Result } from "effect";
import type { McpEntry } from "../../contracts/pi/mcp-settings-data";
const record = Schema.Record(Schema.String, Schema.Json);
/** Stored documents can contain invalid native entries; extract display fields without widening them. */
export function mcpText(value: McpEntry["config"][string] | undefined, fallback = "") {
  const parsed = Schema.decodeUnknownResult(Schema.String)(value);
  return Result.isSuccess(parsed) ? parsed.success : fallback;
}
export function readMcpDraft(config: typeof record.Type) {
  const { command, args, cwd, env, url, description, exposure, enabled, ...remaining } = config;
  const advanced = { ...remaining };
  delete advanced.type;
  const parsedArgs = Schema.decodeUnknownResult(Schema.Array(Schema.String))(args);
  return {
    transport: mcpText(url) ? "http" : "stdio",
    endpoint: mcpText(url) || mcpText(command),
    args: Result.isSuccess(parsedArgs) ? parsedArgs.success.join("\n") : "",
    cwd: mcpText(cwd),
    env: JSON.stringify(env ?? {}, null, 2),
    description: mcpText(description),
    exposure: exposure === "codemode-deferred" ? "codemode" : mcpText(exposure, "codemode"),
    enabled: enabled !== false,
    advanced: JSON.stringify(advanced, null, 2),
  };
}
export function parseMcpObject(text: string) {
  const value: unknown = JSON.parse(text || "{}");
  const decoded = Schema.decodeUnknownResult(record)(value);
  if (Result.isFailure(decoded)) throw new Error("Expected a JSON object.");
  return decoded.success;
}
