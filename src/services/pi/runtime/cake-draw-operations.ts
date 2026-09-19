/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is Cake Draw's precise domain entity. */
import { Buffer } from "node:buffer";
import { extname } from "node:path";
import { Schema } from "effect";
import type { DrawBoardMetadata } from "../../../domain/draw/draw-board-data";
import type { JsonObject } from "../../../ipc/json-contract";
import {
  DRAW_APPLY_MAX_OPERATIONS,
  type DrawControlResponse,
  DrawOperation,
  DrawReadScope,
  type DrawControlInvocation,
} from "../../../domain/draw/draw-control";
import {
  MAX_CAKE_OPERATION_IMAGE_BYTES,
  cakeOperationImageResult,
  type CakeOperationDefinition,
  type CakeOperationResult,
} from "./cake-operation-registry";

export interface CakeDrawControl {
  readonly list: (signal: AbortSignal) => Promise<ReadonlyArray<DrawBoardMetadata>>;
  readonly create: (title: string, signal: AbortSignal) => Promise<DrawBoardMetadata>;
  readonly open: (boardId: string, signal: AbortSignal) => Promise<typeof DrawControlResponse.Type>;
  readonly request: (
    invocation: DrawControlInvocation,
    signal: AbortSignal,
  ) => Promise<typeof DrawControlResponse.Type>;
  readonly exportFile: (
    path: string,
    content: Uint8Array,
    signal: AbortSignal,
  ) => Promise<{ readonly path: string; readonly bytes: number }>;
  readonly canMutate: () => boolean;
}

const empty = Schema.Struct({});
const optionalBoardId = Schema.optionalKey(Schema.String.check(Schema.isUUID(4)));
const title = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200)));

function requireSuccess(response: typeof DrawControlResponse.Type) {
  if (!response.ok) throw new Error(`${response.code}: ${response.message}`);
  return response;
}

function requireMutable(control: CakeDrawControl) {
  if (!control.canMutate())
    throw new Error("SESSION_RESOLVED: Restore the Project Session before changing its boards.");
}

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeDrawPng(dataUrl: string) {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix))
    throw new Error("INVALID_REQUEST: Cake Draw returned an invalid PNG data URL");
  const data = dataUrl.slice(prefix.length);
  if (!base64Pattern.test(data))
    throw new Error("INVALID_REQUEST: Cake Draw returned malformed PNG base64");
  const bytes = Buffer.from(data, "base64");
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < pngSignature.length ||
    pngSignature.some((expected, index) => bytes[index] !== expected)
  )
    throw new Error("INVALID_REQUEST: Cake Draw returned malformed PNG bytes");
  if (bytes.length > MAX_CAKE_OPERATION_IMAGE_BYTES)
    throw new Error(
      `INVALID_REQUEST: Rendered PNG exceeds ${MAX_CAKE_OPERATION_IMAGE_BYTES} bytes`,
    );
  return { data, bytes };
}

function encodeDrawSvg(source: string) {
  if (source.length > MAX_CAKE_OPERATION_IMAGE_BYTES)
    throw new Error(
      `INVALID_REQUEST: Rendered SVG exceeds ${MAX_CAKE_OPERATION_IMAGE_BYTES} bytes`,
    );
  const normalized = source.trimStart();
  if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/u.test(normalized) || !normalized.includes("</svg>"))
    throw new Error("INVALID_REQUEST: Cake Draw returned malformed SVG source");
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > MAX_CAKE_OPERATION_IMAGE_BYTES)
    throw new Error(
      `INVALID_REQUEST: Rendered SVG exceeds ${MAX_CAKE_OPERATION_IMAGE_BYTES} bytes`,
    );
  return bytes;
}

export function createCakeDrawOperations(control: CakeDrawControl): CakeOperationDefinition[] {
  const operation = <Input>(definition: {
    command: string;
    summary: string;
    schema: Schema.ConstraintDecoder<Input, never>;
    example: JsonObject;
    result: string;
    limitations?: readonly string[];
    execute(input: Input, signal: AbortSignal): Promise<CakeOperationResult>;
  }): CakeOperationDefinition => ({
    command: definition.command,
    topic: "draw",
    summary: definition.summary,
    guidance: [
      "Cake Draw commands always target the calling Project Session and never accept a sessionId.",
      "enter and open explicitly foreground Cake Draw. read, render, and apply never switch the user's board or mode; follow their recovery code when Draw is not visible.",
      "User drawing never triggers an agent turn. Every agent canvas change requires an explicit draw.apply call.",
      "enter and open return the visible viewport and shape bounds. Inspect those coordinates before placing the first shape, prefer create-relative for later shapes, and render the result for visual verification.",
      `Keep each draw.apply to one visible stage of at most ${DRAW_APPLY_MAX_OPERATIONS} operations (for example, one region, then connections, then cleanup). Use another apply for the next stage so the user sees steady progress.`,
      "draw.apply is presented on the canvas operation by operation, then persisted once; order node creation before connections so the user can follow the construction. Use draw.read or draw.render between major stages when visual feedback could improve accuracy.",
    ],
    inputSchema: definition.schema,
    examples: [{ input: definition.example }],
    result: definition.result,
    limitations: [
      "Canvas inspection and mutation require this Project Session to be visible in the invoking window.",
      "Resolved Project Sessions may be inspected but not mutated.",
      ...(definition.limitations ?? []),
    ],
    execute: (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with this definition's schema.
      return definition.execute(input as Input, context.signal);
    },
  });

  return [
    operation({
      command: "draw.enter",
      summary: "Foreground Cake Draw for the calling Project Session.",
      schema: empty,
      example: {},
      result: "The board opened in Cake Draw with its visible viewport and shape positions.",
      execute: async (_input, signal) => {
        const boards = await control.list(signal);
        if (boards.length > 0)
          return requireSuccess(await control.request({ _tag: "Enter" }, signal));
        requireMutable(control);
        const created = await control.create("Board 1", signal);
        return requireSuccess(await control.open(created.id, signal));
      },
    }),
    operation({
      command: "draw.list",
      summary: "List the calling Project Session's boards without opening the canvas.",
      schema: empty,
      example: {},
      result: "Board metadata including IDs, titles, revisions, and timestamps.",
      execute: async (_input, signal) => [...(await control.list(signal))],
    }),
    operation({
      command: "draw.create",
      summary: "Create a blank board without opening or switching the canvas.",
      schema: Schema.Struct({ title }),
      example: { title: "Architecture sketch" },
      result: "Metadata for the newly created blank board.",
      execute: async (input, signal) => {
        requireMutable(control);
        return control.create(input.title, signal);
      },
    }),
    operation({
      command: "draw.open",
      summary: "Foreground Cake Draw and open one board owned by the calling Project Session.",
      schema: Schema.Struct({ boardId: Schema.String.check(Schema.isUUID(4)) }),
      example: { boardId: "00000000-0000-4000-8000-000000000000" },
      result: "The board opened in Cake Draw with its visible viewport and shape positions.",
      execute: async (input, signal) => requireSuccess(await control.open(input.boardId, signal)),
    }),
    operation({
      command: "draw.read",
      summary: "Read a bounded semantic summary of the open board.",
      schema: Schema.Struct({ boardId: optionalBoardId, scope: DrawReadScope }),
      example: { scope: "viewport" },
      result: "The open board ID, viewport, selection, and bounded semantic shape summaries.",
      execute: async (input, signal) =>
        requireSuccess(await control.request({ _tag: "Read", ...input }, signal)),
    }),
    operation({
      command: "draw.render",
      summary: "Render the open board as a PNG image for model vision.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        scope: DrawReadScope,
        background: Schema.optionalKey(Schema.Boolean),
        scale: Schema.optionalKey(
          Schema.Number.check(
            Schema.isFinite(),
            Schema.isGreaterThan(0),
            Schema.isLessThanOrEqualTo(4),
          ),
        ),
      }),
      example: { scope: "viewport", scale: 1 },
      result:
        "A real PNG image block plus concise dimensions and board metadata; no base64 is retained in details.",
      execute: async (input, signal) => {
        const response = requireSuccess(
          await control.request({ _tag: "Render", ...input, format: "png" }, signal),
        );
        if (response.kind !== "rendered")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        if (response.render.format !== "png" || response.render.mediaType !== "image/png")
          throw new Error("INVALID_REQUEST: Cake Draw returned a non-PNG render");
        const { data } = decodeDrawPng(response.render.data);
        return cakeOperationImageResult(
          {
            boardId: response.boardId,
            format: "png",
            width: response.render.width,
            height: response.render.height,
          },
          [{ type: "image", mimeType: "image/png", data }],
        );
      },
    }),
    operation({
      command: "draw.export",
      summary:
        "Render the open board and write it to an explicit workspace-relative PNG or SVG path.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        scope: Schema.optionalKey(DrawReadScope),
        format: Schema.Literals(["png", "svg"]),
        path: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
      }),
      example: { format: "png", scope: "page", path: "docs/architecture-board.png" },
      result:
        "The workspace-relative output path, exact byte count, format, and source board ID. Image or SVG content is never returned in the transcript.",
      limitations: [
        "Export supports only PNG to a .png path and SVG to a .svg path.",
        "The path must be relative to the calling session's Working Directory, its parent directory must already exist, and symlink escapes are rejected.",
        "An existing target file is replaced using Cake's normal write-file semantics.",
        "Export does not publish an artifact or create an editable .tldr document.",
      ],
      execute: async (input, signal) => {
        const expectedExtension = `.${input.format}`;
        if (extname(input.path).toLowerCase() !== expectedExtension)
          throw new Error(
            `INVALID_REQUEST: draw.export format ${input.format} requires a ${expectedExtension} path`,
          );
        const response = requireSuccess(
          await control.request(
            {
              _tag: "Render",
              boardId: input.boardId,
              scope: input.scope ?? "page",
              format: input.format,
            },
            signal,
          ),
        );
        if (response.kind !== "rendered")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        if (response.render.format !== input.format)
          throw new Error("INVALID_REQUEST: Cake Draw returned the wrong export format");
        let content: Uint8Array;
        if (input.format === "png") {
          if (response.render.mediaType !== "image/png")
            throw new Error("INVALID_REQUEST: Cake Draw returned a non-PNG export");
          content = decodeDrawPng(response.render.data).bytes;
        } else {
          if (response.render.mediaType !== "image/svg+xml")
            throw new Error("INVALID_REQUEST: Cake Draw returned a non-SVG export");
          content = encodeDrawSvg(response.render.data);
        }
        const written = await control.exportFile(input.path, content, signal);
        return {
          boardId: response.boardId,
          path: written.path,
          bytes: written.bytes,
          format: input.format,
          overwritePolicy: "replace-existing",
        };
      },
    }),
    operation({
      command: "draw.apply",
      summary:
        "Apply an explicit bounded semantic operation batch to the open board and durably flush it.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        operations: Schema.Array(DrawOperation).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(DRAW_APPLY_MAX_OPERATIONS),
        ),
      }),
      example: {
        operations: [
          {
            type: "create",
            shape: {
              id: "idea",
              type: "geo",
              x: 80,
              y: 80,
              width: 240,
              height: 120,
              text: "Idea",
            },
          },
          {
            type: "create-relative",
            shape: {
              id: "result",
              type: "geo",
              width: 240,
              height: 120,
              text: "Result",
              placement: { relativeTo: "idea", side: "right", gap: 100 },
            },
          },
          { type: "connect", fromId: "idea", toId: "result" },
        ],
      },
      result:
        "The open board ID and a compact created, updated, and deleted shape receipt after animated playback and durable flush. Use draw.read when the next stage needs resulting positions.",
      execute: async (input, signal) => {
        requireMutable(control);
        const response = requireSuccess(await control.request({ _tag: "Apply", ...input }, signal));
        if (response.kind !== "applied")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return { boardId: response.boardId, receipt: response.receipt };
      },
    }),
  ];
}
