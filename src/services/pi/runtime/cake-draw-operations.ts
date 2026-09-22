/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is Cake Draw's precise domain entity. */
import { Buffer } from "node:buffer";
import { extname } from "node:path";
import { Schema } from "effect";
import type { DrawBoardMetadata } from "../../../domain/draw/draw-board-data";
import type { JsonObject } from "../../../ipc/json-contract";
import {
  DRAW_APPLY_MAX_OPERATIONS,
  type DrawControlResponse,
  DrawMaxRenderSize,
  DrawOperation,
  DrawFlowInput,
  DrawFrameInput,
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
      "Targets only the calling Project Session. Only enter/open foreground Draw; other commands require its visible board. User edits never start agent turns.",
      "For guided steps use flow (measured nodes, arrows, optional frame) and frame (contain existing shapes). Placement uses live shape:<id> bounds; existing content is never relaid out. Mermaid is for complete named diagrams; apply is for targeted edits.",
      "Mutation receipts include stable IDs, live layout/bounds and an undo checkpoint after playback and durable flush. Automatic fit includes the composition at no more than 100% zoom. Read when user edits/context matter; render viewport only to investigate visual issues.",
      "Deliver one meaningful visual step, explain briefly, then wait. Guide progress can use plugins.patch without resending actions. No transient spotlight is exposed; use selection for emphasis.",
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
      command: "draw.flow",
      summary:
        "Lay out 1–8 new labeled nodes with arrows and an optional native frame, without coordinates.",
      schema: Schema.Struct({ boardId: optionalBoardId, ...DrawFlowInput.fields }),
      example: {
        nodes: [
          { id: "shape:request", text: "Request" },
          { id: "shape:service", text: "Service" },
        ],
        frame: { id: "shape:runtime", title: "Runtime" },
      },
      result:
        "Board ID, checkpoint, created IDs and compact live layout/bounds. Nodes and frame retain supplied IDs; arrow IDs are returned.",
      limitations: [
        "Defaults: down, connected, 220-wide measured nodes, 80 gap, readable sans-serif type. Use direction:right for a horizontal flow or connect:false for an unconnected row/column.",
        "placement:{relativeTo,side,gap?,align?} places the entire new stage using live bounds. Default gap is 80 and alignment center. Obstructions slide new content outward on that side; without placement, use a collision-free viewport location.",
        "IDs must be new. This never replaces a diagram or relayouts user edits. Extend beside an existing node/frame, then use apply connect for a cross-stage edge. Frames cannot nest; each flow is one visible stage in the Apply playback transaction.",
      ],
      execute: async ({ boardId, ...input }, signal) => {
        requireMutable(control);
        const response = requireSuccess(
          await control.request(
            {
              _tag: "Apply",
              ...(boardId ? { boardId } : null),
              operations: [{ type: "flow", ...input }],
            },
            signal,
          ),
        );
        if (response.kind !== "applied")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return {
          boardId: response.boardId,
          checkpointId: response.checkpointId,
          receipt: response.receipt,
        };
      },
    }),
    operation({
      command: "draw.frame",
      summary:
        "Fit a named native frame around existing shapes and their labels without moving them.",
      schema: Schema.Struct({ boardId: optionalBoardId, ...DrawFrameInput.fields }),
      example: {
        id: "shape:boundary",
        title: "Ownership boundary",
        ids: ["shape:request", "shape:service"],
      },
      result:
        "Board ID, checkpoint and compact live layout/bounds including the frame and its members. Layout is capped at 200 roots with layoutTruncated:true when needed; composition bounds remain complete.",
      limitations: [
        "Creates a new frame with 32 padding. Children must be unframed; include internal connectors in ids. Native membership is editable. Moving the frame moves its children; deleting the frame preserves them. Fitting is one-shot, not a persistent layout constraint.",
      ],
      execute: async ({ boardId, ...input }, signal) => {
        requireMutable(control);
        const response = requireSuccess(
          await control.request(
            {
              _tag: "Apply",
              ...(boardId ? { boardId } : null),
              operations: [{ type: "frame", ...input }],
            },
            signal,
          ),
        );
        if (response.kind !== "applied")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return {
          boardId: response.boardId,
          checkpointId: response.checkpointId,
          receipt: response.receipt,
        };
      },
    }),
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
        maxSize: Schema.optionalKey(DrawMaxRenderSize),
      }),
      example: { scope: "viewport", scale: 1, maxSize: { width: 1600, height: 1200 } },
      result:
        "A PNG image block plus dimensions and board metadata; no base64 is retained in details. Viewport scope preserves the visible crop (even when empty); page/selection fit content. All scopes downscale to maxSize.",
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
      command: "draw.clear",
      summary: "Clear every shape from the open board as one checkpointed transaction.",
      schema: Schema.Struct({ boardId: optionalBoardId }),
      example: {},
      result: "The board ID, deleted canonical shape IDs, and checkpoint ID for one-step undo.",
      execute: async (input, signal) => {
        requireMutable(control);
        const response = requireSuccess(await control.request({ _tag: "Clear", ...input }, signal));
        if (response.kind !== "cleared")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return {
          boardId: response.boardId,
          checkpointId: response.checkpointId,
          receipt: response.receipt,
        };
      },
    }),
    operation({
      command: "draw.undo",
      summary: "Restore the board snapshot before an agent-generated mutation.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        checkpointId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      }),
      example: {},
      result: "The restored board ID and consumed checkpoint ID.",
      limitations: [
        "Agent checkpoints are bounded to the mounted board's renderer lifetime and reset on board reload; ordinary Excalidraw history remains available to the user.",
      ],
      execute: async (input, signal) => {
        requireMutable(control);
        const response = requireSuccess(await control.request({ _tag: "Undo", ...input }, signal));
        if (response.kind !== "undone")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return {
          boardId: response.boardId,
          checkpointId: response.checkpointId,
          receipt: response.receipt,
        };
      },
    }),
    operation({
      command: "draw.mermaid",
      summary: "Convert Mermaid source into native editable Excalidraw elements on the open board.",
      schema: Schema.Struct({
        boardId: optionalBoardId,
        diagram: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50_000)),
        id: Schema.optionalKey(
          Schema.String.check(
            Schema.isMinLength(1),
            Schema.isMaxLength(128),
            Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
          ),
        ),
        replace: Schema.optionalKey(Schema.Boolean),
      }),
      example: {
        id: "request-flow",
        replace: true,
        diagram:
          'flowchart LR\n  Request["HTTP Request\\nvalidated"] --> Service["API Service"]\n  Service -->|query| Database[(Database)]',
      },
      result:
        "The board ID, checkpoint, native element count, stable diagram ID, and semantic-to-shape mappings.",
      limitations: [
        "The Mermaid source must be valid and is limited to 50,000 characters.",
        "Native editable conversion supports flowchart, sequenceDiagram, classDiagram, stateDiagram, and erDiagram. Diagram kinds that the converter can only render as an image are rejected.",
        "Labels support plain text plus \\n, <br>, <br/>, or <br /> line breaks. Other HTML markup is rejected instead of being rendered literally.",
        "The converted diagram is inserted at the nearest collision-free position around the current viewport and selected. Exact coincident parallel connectors are separated; broader routing cleanup remains available through draw.apply.",
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
          checkpointId: response.checkpointId,
          ...(response.diagramId ? { diagramId: response.diagramId } : null),
          elementCount: response.elementCount,
          mappings: response.mappings,
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
              id: "shape:idea",
              type: "geo",
              x: 80,
              y: 80,
              width: 240,
              height: 120,
              text: "Idea",
              sourceLink: {
                path: "src/idea.ts",
                range: { start: { line: 11 }, end: { line: 18 } },
              },
            },
          },
          {
            type: "create-relative",
            shape: {
              id: "shape:result",
              type: "geo",
              width: 240,
              height: 120,
              text: "Result",
              placement: { relativeTo: "shape:idea", side: "right", gap: 100 },
            },
          },
          { type: "connect", fromId: "shape:idea", toId: "shape:result", routing: "orthogonal" },
          {
            type: "style",
            ids: ["shape:idea", "shape:result"],
            style: {
              strokeColor: "blue",
              backgroundColor: "light-blue",
              fill: "solid",
              roundness: "round",
            },
          },
          { type: "update", id: "shape:result", width: 280, height: 140, geo: "ellipse" },
        ],
      },
      result:
        "The open board ID and a compact created, updated, and deleted shape receipt after animated playback and durable flush. Includes complete composition bounds and per-shape layout without a read (up to 200 roots; layoutTruncated:true marks a partial listing). Updated shapes retain their IDs. Source links use Working Directory-relative paths and zero-based ranges; update sourceLink:null removes a link.",
      limitations: [
        "Geometry conversion is intentionally limited to rectangle, ellipse, and diamond. Linear shapes resize through endX/endY; free-draw point editing is not exposed.",
        "Fill/background/roundness apply only to rectangle, ellipse, and diamond; typography applies only to text or labeled shapes; arrowheads apply only to lines and arrows.",
        "The semantic agent protocol exposes only validated Cake source links, not arbitrary hyperlinks, raw Excalidraw patches, clipboard actions, image import, or freehand creation. Named diagram grouping and checkpoint undo use their focused operations.",
      ],
      execute: async (input, signal) => {
        requireMutable(control);
        const response = requireSuccess(await control.request({ _tag: "Apply", ...input }, signal));
        if (response.kind !== "applied")
          throw new Error("INVALID_REQUEST: Unexpected Draw response");
        return {
          boardId: response.boardId,
          checkpointId: response.checkpointId,
          receipt: response.receipt,
        };
      },
    }),
  ];
}
