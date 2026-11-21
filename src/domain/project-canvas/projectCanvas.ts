import { DateTime, Effect, Schema, Stream } from "effect";
import { searchCanvas } from "../../utils/project-canvas-search";
import { formatArtifactRef, parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import { canvasLink, parseCanvasLink } from "../../contracts/project-canvas/canvas-link";
import {
  CanvasImage,
  ProjectCanvasError,
  type CanvasCard,
  type CanvasDetail,
  type CanvasPinInput,
  type CanvasPublish,
  type CanvasResults,
  type CanvasRevision,
  type CanvasSearch,
  type CanvasSnapshot,
} from "../../contracts/project-canvas/project-canvas";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ProjectCanvasStorage } from "../../services/storage/ProjectCanvasStorage";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { readExactRevision, resolveEffectiveReference } from "../artifacts/artifactWorkflows";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";

const fail = (message: string) => new ProjectCanvasError({ message });
const externalError = (error: { message: string }) => fail(error.message);
const requireProject = Effect.fn("ProjectCanvas.requireProject")(function* (id: string) {
  const project = (yield* ApplicationState)
    .snapshot()
    .projects.find((item) => projectChatSessionId(item.path) === id);
  if (!project) return yield* fail("This Canvas does not belong to a registered project.");
});

export const observe = (id: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* requireProject(id);
      return (yield* ProjectCanvasStorage).observe(id).pipe(Stream.tap(() => requireProject(id)));
    }),
  );

const detail = (
  projectChatId: string,
  card: CanvasCard,
  revision: CanvasRevision,
): typeof CanvasDetail.Type => {
  const target = { projectChatId, cardId: card.id };
  return {
    cardId: card.id,
    group: card.group,
    revision,
    link: canvasLink({ ...target, revision: revision.number }),
    stableLink: canvasLink(target),
    history: card.revisions.map(({ number, title, publisher, at }) => ({
      number,
      title,
      publisher,
      at,
      link: canvasLink({ ...target, revision: number }),
    })),
  };
};

const lookup = Effect.fn("ProjectCanvas.lookup")(function* (
  board: CanvasSnapshot,
  id: string,
  link: string,
) {
  const ref = parseCanvasLink(link);
  if (!ref || ref.projectChatId !== id)
    return yield* fail("That link is not on this project’s Canvas.");
  const card = board.cards.find((item) => item.id === ref.cardId);
  const revision =
    ref.revision === undefined
      ? card?.revisions.at(-1)
      : card?.revisions.find((item) => item.number === ref.revision);
  if (!card || !revision) return yield* fail("Canvas card or revision not found.");
  return { ref, card, revision };
});

export const read = Effect.fn("ProjectCanvas.read")(function* (id: string, link: string) {
  yield* requireProject(id);
  const board = yield* (yield* ProjectCanvasStorage).load(id);
  const { card, revision } = yield* lookup(board, id, link);
  return detail(id, card, revision);
});

export const search = Effect.fn("ProjectCanvas.search")(function* (
  id: string,
  input: typeof CanvasSearch.Type,
): Effect.fn.Return<
  typeof CanvasResults.Type,
  ProjectCanvasError,
  ApplicationState | ProjectCanvasStorage
> {
  yield* requireProject(id);
  const board = yield* (yield* ProjectCanvasStorage).load(id);
  const hits = searchCanvas(board.cards, input.query ?? "").map(({ card, revision }) => ({
    group: card.group,
    title: revision.title,
    revision: revision.number,
    kind: revision.content.kind,
    at: revision.at,
    link: canvasLink({ projectChatId: id, cardId: card.id, revision: revision.number }),
  }));
  const offset = input.offset ?? 0;
  return {
    items: hits.slice(offset, offset + 20),
    nextOffset: offset + 20 < hits.length ? offset + 20 : null,
  };
});

const screenshotRef = (content: CanvasRevision["content"]) =>
  content.kind === "screenshot"
    ? content.attachmentId
    : content.kind === "artifact"
      ? content.previewAttachmentId
      : undefined;

export const publish = Effect.fn("ProjectCanvas.publish")(function* (
  id: string,
  publisher: string,
  input: CanvasPublish,
) {
  yield* requireProject(id);
  let { content } = input;
  if (content.kind === "artifact") {
    const { revision } = yield* resolveEffectiveReference(publisher, content.reference).pipe(
      Effect.mapError(externalError),
    );
    if (revision.snapshot.kind === "message-board")
      return yield* fail("Family Workboards cannot be published to a Project Canvas.");
    content = {
      ...content,
      reference: formatArtifactRef({
        lineageId: revision.lineageId,
        revision: revision.metadata.revision,
      }),
    };
  }
  const attachmentId = screenshotRef(content);
  if (attachmentId) {
    const image = yield* (yield* TaskInputStorage)
      .inspect(publisher, { reference: attachmentId })
      .pipe(Effect.mapError(externalError));
    if (image.kind !== "image")
      return yield* fail("Publish a supported image attachment as a screenshot.");
  }
  const storage = yield* ProjectCanvasStorage;
  const at = DateTime.formatIso(yield* DateTime.now);
  return yield* storage.update(
    id,
    Effect.fn("ProjectCanvas.appendRevision")(function* (board) {
      const prior = input.previous ? yield* lookup(board, id, input.previous) : undefined;
      if (
        prior &&
        (prior.ref.revision === undefined ||
          prior.card.revisions.at(-1)?.number !== prior.ref.revision)
      )
        return yield* fail("To revise a card, pass its current exact revision link as previous.");
      if (prior && prior.card.group !== input.group)
        return yield* fail("A revision must stay in its card’s named group.");
      const revision: CanvasRevision = {
        number: (prior?.revision.number ?? 0) + 1,
        publisher,
        at,
        title: input.title,
        content,
        aspect: input.aspect ?? prior?.revision.aspect ?? 1.6,
        pins: [],
      };
      const card: CanvasCard = prior
        ? { ...prior.card, revisions: [...prior.card.revisions, revision] }
        : { id: crypto.randomUUID(), group: input.group, revisions: [revision] };
      const cards = prior
        ? board.cards.map((item) => (item.id === card.id ? card : item))
        : [...board.cards, card];
      return { board: { ...board, cards }, result: detail(id, card, revision) };
    }),
  );
});

export const pin = Effect.fn("ProjectCanvas.pin")(function* (
  id: string,
  { link, ...pin }: CanvasPinInput,
) {
  yield* requireProject(id);
  const storage = yield* ProjectCanvasStorage;
  const at = DateTime.formatIso(yield* DateTime.now);
  return yield* storage.update(
    id,
    Effect.fn("ProjectCanvas.appendPin")(function* (board) {
      const { ref, card, revision } = yield* lookup(board, id, link);
      if (ref.revision === undefined) return yield* fail("Pin feedback on an exact revision link.");
      const entry = { ...pin, id: crypto.randomUUID(), at };
      const next = { ...revision, pins: [...revision.pins, entry] };
      return {
        board: {
          ...board,
          cards: board.cards.map((item) =>
            item.id === card.id
              ? {
                  ...card,
                  revisions: [
                    next.number === card.revisions[0].number ? next : card.revisions[0],
                    ...card.revisions
                      .slice(1)
                      .map((rev) => (rev.number === next.number ? next : rev)),
                  ],
                }
              : item,
          ),
        },
        result: entry,
      };
    }),
  );
});

export const preview = Effect.fn("ProjectCanvas.preview")(function* (id: string, link: string) {
  const {
    revision: { content, publisher },
  } = yield* read(id, link);
  const attachmentId = screenshotRef(content);
  if (attachmentId) {
    const image = yield* (yield* TaskInputStorage)
      .inspect(publisher, { reference: attachmentId })
      .pipe(Effect.mapError(externalError));
    return image.kind === "image" ? { mimeType: image.mimeType, data: image.data } : null;
  }
  if (content.kind === "artifact") {
    const parsed = parseArtifactRef(content.reference);
    if (parsed.revision === undefined)
      return yield* fail("Canvas artifact previews require an exact revision.");
    const { snapshot } = yield* readExactRevision(parsed.lineageId, parsed.revision).pipe(
      Effect.mapError(externalError),
    );
    if (snapshot.kind === "widget" && snapshot.payload.preview)
      return { mimeType: "image/png" as const, data: snapshot.payload.preview.data };
    if (snapshot.kind === "file") {
      const { mimeType, data } = snapshot.payload;
      const image = { mimeType, data };
      if (Schema.is(CanvasImage)(image)) return image;
    }
  }
  return null;
});
