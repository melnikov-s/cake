import { Effect, Layer } from "effect";
import { AttachmentUploadError } from "../../../src/contracts/filesystem/attachment-uploads-errors";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { unstubbed } from "./unstubbed";

type Service = TaskInputStorage["Service"];

const unknownReferences = (operation: string, ids: readonly string[]) =>
  ids.length === 0
    ? Effect.succeed([])
    : Effect.fail(
        new AttachmentUploadError({ operation, message: `Unknown task inputs: ${ids.join(", ")}` }),
      );

/** An empty task-input store: no references exist and nobody is a protected recipient.
 * Plain attachments resolve as themselves; storing new inputs is unstubbed. */
const neutralTaskInputStorage = (): Service => ({
  isolate: (_owner, attachments) =>
    attachments.length === 0 ? Effect.succeed([]) : unstubbed("TaskInputStorage.isolate"),
  authorizeForward: (_owner, ids) => unknownReferences("authorizeForward", ids),
  resolve: (_recipient, attachments) => Effect.succeed(attachments),
  grant: (_recipient, references) => unknownReferences("grant", references),
  list: () => Effect.succeed({ references: [], nextAfter: null }),
  inspect: () =>
    Effect.fail(new AttachmentUploadError({ operation: "inspect", message: "Unknown task input" })),
  recipients: () => Effect.succeed(new Set<string>()),
  isRecipient: () => Effect.succeed(false),
  protectRecipient: () => Effect.void,
});

export const fakeTaskInputStorage = (overrides: Partial<Service> = {}) =>
  Layer.succeed(
    TaskInputStorage,
    TaskInputStorage.of({ ...neutralTaskInputStorage(), ...overrides }),
  );
