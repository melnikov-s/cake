import { Effect, Schema } from "effect";
import {
  type WidgetAttachment,
  widgetAttachmentContracts,
} from "../../contracts/widgets/widget-attachment";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { toJsonValue } from "../../utils/to-json-value";

class WidgetAttachmentError extends Schema.TaggedError<WidgetAttachmentError>()(
  "WidgetAttachmentError",
  { message: Schema.String },
) {}

export const attach = Effect.fn("WidgetAttachments.attach")(function* (
  input: (typeof widgetAttachmentContracts)[0]["inputSchema"]["Type"],
) {
  const storage = yield* ArtifactStorage;
  const artifact = yield* storage.read(input.lineageId);
  if (artifact?.snapshot.kind !== "widget")
    return yield* new WidgetAttachmentError({ message: "Only widget instances can be attached" });
  const owner = yield* ApplicationState;
  return yield* owner.transact((state) => {
    const existing = state.widgetAttachments.find((entry) => entry.id === input.id);
    if (existing && existing.lineageId !== input.lineageId)
      return Effect.fail(
        new WidgetAttachmentError({
          message: "An attachment cannot change widget identity; detach it first",
        }),
      );
    const others = state.widgetAttachments.filter((entry) => entry.id !== input.id);
    if (
      input.slot === "tab" &&
      others.some((entry) => entry.slot === "tab" && entry.lineageId === input.lineageId)
    )
      return Effect.fail(
        new WidgetAttachmentError({
          message: "This widget already has a tab attachment; reuse its attachment ID to move it",
        }),
      );
    if (others.length >= 500)
      return Effect.fail(
        new WidgetAttachmentError({ message: "At most 500 widget attachments are supported" }),
      );
    const ordered = others
      .filter((entry) => entry.slot === input.slot)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const order = Math.min(
      input.order ?? (existing?.slot === input.slot ? existing.order : ordered.length),
      ordered.length,
    );
    const attachment: WidgetAttachment = { ...input, order, hidden: existing?.hidden ?? false };
    ordered.splice(order, 0, attachment);
    return Effect.succeed({
      ...state,
      widgetAttachments: [
        ...others.filter((entry) => entry.slot !== input.slot),
        ...ordered.map((entry, index) => ({ ...entry, order: index })),
      ],
    });
  });
});

export const detach = Effect.fn("WidgetAttachments.detach")(function* (id: string) {
  return yield* (yield* ApplicationState).transact((state) =>
    Effect.succeed({
      ...state,
      widgetAttachments: state.widgetAttachments.filter((entry) => entry.id !== id),
    }),
  );
});

export const setHidden = Effect.fn("WidgetAttachments.setHidden")(function* (
  id: string,
  hidden: boolean,
) {
  return yield* (yield* ApplicationState).transact((state) =>
    Effect.succeed({
      ...state,
      widgetAttachments: state.widgetAttachments.map((entry) =>
        entry.id === id ? { ...entry, hidden } : entry,
      ),
    }),
  );
});

export const invoke = Effect.fn("WidgetAttachments.invoke")(function* (
  command: string,
  input: JsonValue,
) {
  if (command === "widgets.attach") {
    const parsed = yield* Schema.decodeUnknownEffect(widgetAttachmentContracts[0].inputSchema)(
      input,
      { onExcessProperty: "error" },
    );
    yield* attach(parsed);
    return toJsonValue({ id: parsed.id, lineageId: parsed.lineageId, attached: true });
  }
  if (command === "widgets.detach") {
    const parsed = yield* Schema.decodeUnknownEffect(widgetAttachmentContracts[1].inputSchema)(
      input,
      { onExcessProperty: "error" },
    );
    yield* detach(parsed.id);
    return toJsonValue({ id: parsed.id, detached: true });
  }
  yield* Schema.decodeUnknownEffect(widgetAttachmentContracts[2].inputSchema)(input, {
    onExcessProperty: "error",
  });
  return toJsonValue({ attachments: (yield* ApplicationState).snapshot().widgetAttachments });
});
