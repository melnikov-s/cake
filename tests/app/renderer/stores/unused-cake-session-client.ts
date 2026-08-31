import { Effect, Stream } from "effect";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";

export const unusedCakeChats = {
  list: () => Effect.die("not used"),
  inspect: () => Effect.die("not used"),
  open: () => Effect.die("not used"),
  observe: () => Stream.die("not used"),
  prompt: () => Effect.die("not used"),
  abort: () => Effect.die("not used"),
  compact: () => Effect.die("not used"),
  editMessage: () => Effect.die("not used"),
  applyConfiguration: () => Effect.die("not used"),
  setModel: () => Effect.die("not used"),
  setThinkingLevel: () => Effect.die("not used"),
  setFastMode: () => Effect.die("not used"),
  rename: () => Effect.die("not used"),
  handoff: () => Effect.die("not used"),
  resolve: () => Effect.die("not used"),
  restore: () => Effect.die("not used"),
  deleteResolved: () => Effect.die("not used"),
  respondControl: () => Effect.die("not used"),
} satisfies CakeIpcClientService["cakeChats"];

export const unusedDiscussionSessions = {
  list: () => Effect.die("not used"),
  create: () => Effect.die("not used"),
  observe: () => Stream.die("not used"),
  prompt: () => Effect.die("not used"),
  abort: () => Effect.die("not used"),
  setResolved: () => Effect.die("not used"),
} satisfies CakeIpcClientService["discussionSessions"];
