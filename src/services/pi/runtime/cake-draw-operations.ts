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

const ExcalidrawDocument = Schema.Struct({
  type: Schema.Literal("excalidraw"),
  version: Schema.Number,
  source: Schema.String,
  elements: Schema.Array(Schema.Json),
  appState: Schema.Record(Schema.String, Schema.Json),
  files: Schema.Record(Schema.String, Schema.Json),
});

function encodeExcalidrawDocument(source: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
    Schema.decodeUnknownSync(ExcalidrawDocument)(parsed);
  } catch {
    throw new Error("INVALID_REQUEST: Cake Draw returned an invalid Excalidraw document");
  }
  return new TextEncoder().encode(source);
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
      "enter and open explicitly foreground Cake Draw. read, render, mermaid, and apply never switch the user's board or mode; follow their recovery code when Draw is not visible.",
      "User drawing never triggers an agent turn. Every agent canvas change requires an explicit draw.mermaid or draw.apply call.",
      "Prefer draw.mermaid for architecture, flow, sequence, class, state, and entity-relationship diagrams. It produces native editable Excalidraw elements without manual placement.",
      "Use draw.apply for freeform drawings, small targeted edits, or diagram types Mermaid cannot express. enter and open return the visible viewport, selection, shape bounds, and compact style summaries for manual placement and editing.",
      "Edit existing shapes without replacing them: update changes position, size, endpoints, rotation, text, opacity, or rectangle/ellipse/diamond geometry while preserving the shape ID; style applies colors, fill, stroke, opacity, roundness, typography/alignment, or arrowheads to one or more IDs.",
      "Selection and arrangement operations include select (an empty IDs list clears selection), zoom-to, move, align, distribute, four layer-order operations, set-locked, and delete. Use read scope selection to inspect the current selection.",
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
      summary: "Inspect the calling Project Session's board metadata without opening the canvas.",
      schema: empty,
      example: {},
      result: "The board metadata, including its ID, revision, and timestamps.",
      execute: async (_input, signal) => [...(await control.list(signal))],
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
        "Export the open board to an explicit workspace-relative PNG, SVG, or editable Excalidraw path.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        scope: Schema.optionalKey(DrawReadScope),
        format: Schema.Literals(["png", "svg", "excalidraw"]),
        path: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
      }),
      example: { format: "png", scope: "page", path: "docs/architecture-board.png" },
      result:
        "The workspace-relative output path, exact byte count, format, and source board ID. Export content is never returned in the transcript.",
      limitations: [
        "Export supports PNG to a .png path, SVG to a .svg path, and editable Excalidraw JSON to a .excalidraw path. scope applies to image exports; editable export always includes the whole board.",
        "The path must be relative to the calling session's Working Directory, its parent directory must already exist, and symlink escapes are rejected.",
        "An existing target file is replaced using Cake's normal write-file semantics.",
        "Export does not publish an artifact or alter the active Cake Draw board or its persistence binding.",
      ],
      execute: async (input, signal) => {
        const expectedExtension = `.${input.format}`;
        if (extname(input.path).toLowerCase() !== expectedExtension)
          throw new Error(
            `INVALID_REQUEST: draw.export format ${input.format} requires a ${expectedExtension} path`,
          );
        const response = requireSuccess(
          await control.request(
            input.format === "excalidraw"
              ? {
                  _tag: "ExportDocument",
                  ...(input.boardId ? { boardId: input.boardId } : null),
                }
              : {
                  _tag: "Render",
                  boardId: input.boardId,
                  scope: input.scope ?? "page",
                  format: input.format,
                },
            signal,
          ),
        );
        let content: Uint8Array;
        if (input.format === "excalidraw") {
          if (response.kind !== "exported-document")
            throw new Error("INVALID_REQUEST: Unexpected Draw response");
          content = encodeExcalidrawDocument(response.document);
        } else {
          if (response.kind !== "rendered")
            throw new Error("INVALID_REQUEST: Unexpected Draw response");
          if (response.render.format !== input.format)
            throw new Error("INVALID_REQUEST: Cake Draw returned the wrong export format");
          if (input.format === "png") {
            if (response.render.mediaType !== "image/png")
              throw new Error("INVALID_REQUEST: Cake Draw returned a non-PNG export");
            content = decodeDrawPng(response.render.data).bytes;
          } else {
            if (response.render.mediaType !== "image/svg+xml")
              throw new Error("INVALID_REQUEST: Cake Draw returned a non-SVG export");
            content = encodeDrawSvg(response.render.data);
          }
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
      command: "draw.mermaid",
      summary: "Convert Mermaid source into native editable Excalidraw elements on the open board.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        diagram: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50_000)),
      }),
      example: {
        diagram: "flowchart LR\n  Request --> Service\n  Service --> Database",
      },
      result:
        "The open board ID and number of native Excalidraw elements created and durably saved.",
      limitations: [
        "The Mermaid source must be valid and is limited to 50,000 characters.",
        "The converted diagram is inserted near the center of the current viewport.",
      ],
      execute: async (input, signal) => {
        requireMutable(control);
        const response = requireSuccess(
          await control.request({ _tag: "Mermaid", ...input }, signal),
        );
        if (response.kind !== "mermaid")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return {
          boardId: response.boardId,
          elementCount: response.elementCount,
        };
      },
    }),
    operation({
      command: "draw.apply",
      summary:
        "Create, select, move, resize, restyle, arrange, lock, or delete shapes on the open board, preserving existing IDs.",
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
          {
            type: "style",
            ids: ["idea", "result"],
            style: {
              strokeColor: "blue",
              backgroundColor: "light-blue",
              fill: "solid",
              roundness: "round",
            },
          },
          { type: "update", id: "result", width: 280, height: 140, geo: "ellipse" },
        ],
      },
      result:
        "The open board ID and a compact created, updated, and deleted shape receipt after animated playback and durable flush. Updated shapes retain their IDs. Use draw.read when the next stage needs resulting geometry or styles.",
      limitations: [
        "Geometry conversion is intentionally limited to rectangle, ellipse, and diamond. Linear shapes resize through endX/endY; free-draw point editing is not exposed.",
        "Fill/background/roundness apply only to rectangle, ellipse, and diamond; typography applies only to text or labeled shapes; arrowheads apply only to lines and arrows.",
        "The semantic agent protocol does not expose raw Excalidraw patches, clipboard actions, image import, freehand creation, grouping, hyperlinks, or undo/redo.",
      ],
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
