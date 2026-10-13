import { realpath, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { defineTool, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import type { WidgetCandidate } from "../../../contracts/widgets/widget-candidate";
import { jsonValueSchema } from "../../../contracts/serialization/json-contract";
import { editText } from "../edit-text";
import { canonicalPathIsInsideRoot } from "./workspace-paths";

const targetSchema = Type.Union([Type.Literal("source"), Type.Literal("state")]);
const paging = {
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
};
const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

function page(text: string, offset = 1, limit = 2000) {
  const lines = text.split("\n");
  const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
  const bounded = selected.slice(0, 50_000);
  return (
    bounded +
    (offset - 1 + limit < lines.length || bounded.length < selected.length
      ? "\n[Truncated; continue with offset/limit.]"
      : "")
  );
}

/** Only discovered skill resources and one staged candidate are reachable. */
export async function createWidgetCandidateTools(options: {
  cwd: string;
  candidate: WidgetCandidate;
  skills: ReadonlyArray<Skill>;
}): Promise<ToolDefinition[]> {
  const roots = await Promise.all(options.skills.map((skill) => realpath(skill.baseDir)));
  const candidate = options.candidate;
  return [
    defineTool({
      name: "widget_read",
      label: "Read candidate",
      description:
        "Inspect this private staged widget source or latest staged artifact JSON state. Not live history or filesystem access.",
      parameters: Type.Object({ target: targetSchema, ...paging }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        return result(
          page(
            params.target === "source"
              ? candidate.source
              : JSON.stringify(candidate.state, null, 2),
            params.offset,
            params.limit,
          ),
        );
      },
    }),
    defineTool({
      name: "widget_edit",
      label: "Edit candidate",
      description:
        "Apply surgical Pi text replacements to private candidate source or JSON state. State must remain valid JSON. Does not publish or modify accepted live state. Finish with USE_STAGED_CANDIDATE to submit edited source for mandatory render/review.",
      parameters: Type.Object({
        target: targetSchema,
        edits: Type.Array(
          Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }),
          { minItems: 1 },
        ),
      }),
      executionMode: "sequential",
      async execute(id, params, signal) {
        const activeSignal = signal ?? new AbortController().signal;
        activeSignal.throwIfAborted();
        const text =
          params.target === "source" ? candidate.source : JSON.stringify(candidate.state, null, 2);
        const edited = await editText({
          workingDirectory: options.cwd,
          path: `candidate.${params.target === "source" ? "tsx" : "json"}`,
          text,
          edits: params.edits,
          toolCallId: id,
          signal: activeSignal,
        });
        activeSignal.throwIfAborted();
        if (Buffer.byteLength(edited) > 1_048_576)
          throw new Error("Candidate exceeds the 1 MiB limit");
        if (params.target === "state") {
          const state = Schema.decodeUnknownSync(Schema.fromJsonString(jsonValueSchema))(edited);
          candidate.state = state;
        } else candidate.source = edited;
        return result(
          "Candidate updated privately; acceptance still requires compilation and visual review.",
        );
      },
    }),
    defineTool({
      name: "read",
      label: "Read skill resource",
      description:
        "Read instructions/templates/resources inside discovered skill directories only. No arbitrary workspace, Cake data, session or credential access.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), ...paging }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const path = resolve(options.cwd, params.path);
        if (!roots.some((root) => canonicalPathIsInsideRoot(root, path)))
          throw new Error("Only discovered skill resources may be read");
        const canonical = await realpath(path);
        // Recheck the exact path that will be opened, not just its spelling.
        if (!roots.some((root) => canonicalPathIsInsideRoot(root, canonical)))
          throw new Error("Skill resource resolves outside its directory");
        const metadata = await stat(canonical);
        if (!metadata.isFile() || metadata.size > 1_048_576)
          throw new Error("Skill resource must be a file no larger than 1 MiB");
        const text = await readFile(canonical, "utf8");
        signal?.throwIfAborted();
        return result(page(text, params.offset, params.limit));
      },
    }),
  ];
}
