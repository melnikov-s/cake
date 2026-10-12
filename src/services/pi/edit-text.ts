import { createEditTool } from "@earendil-works/pi-coding-agent";

/** Apply Pi's authoritative edit semantics to staged text, without publishing it. */
export async function editText(input: {
  workingDirectory: string;
  path: string;
  text: string;
  edits: ReadonlyArray<{ oldText: string; newText: string }>;
  toolCallId: string;
  signal: AbortSignal;
}): Promise<string> {
  let text = input.text;
  const tool = createEditTool(input.workingDirectory, {
    operations: {
      access: async () => undefined,
      readFile: async () => Buffer.from(text, "utf-8"),
      writeFile: async (_path, content) => {
        text = content;
      },
    },
  });
  await tool.execute(input.toolCallId, { path: input.path, edits: [...input.edits] }, input.signal);
  return text;
}
