import { Effect } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  isProjectChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import {
  SessionChatError,
  TurnId,
  type SessionChatPromptInput,
} from "../../contracts/conversations/conversation-data";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { antigravityDesktopOnly } from "../../contracts/model-presets/antigravity-model";
import { ClientConnections } from "../../services/clients/ClientConnections";
import type { CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

export type InteractiveModelInput = Pick<
  SessionChatPromptInput,
  | "sessionId"
  | "text"
  | "attachments"
  | "renderUserMessageAsMarkdown"
  | "clientId"
  | "crossSession"
  | "responseMode"
  | "artifactPresentation"
> & {
  automaticTitle?: boolean;
};

export type InteractiveModelSubmit = (
  handle: CakeSessionHandle,
  input: InteractiveModelInput,
) => Effect.Effect<TurnId | undefined, SessionChatError>;

const asPromptError = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError(
      (cause) => new SessionChatError({ operation: "prompt", message: cause.message }),
    ),
  );

/** Choose the transport before preparing any Pi context, attachments, or commands. */
export const interactiveModelPrompt = Effect.fn("Conversations.interactiveModelPrompt")(function* (
  handle: CakeSessionHandle,
  input: InteractiveModelInput,
  connectionId: number,
  nativeDocument: AbortSignal | undefined,
  delivery: "prompt" | "steer" | "follow-up" = "prompt",
) {
  const connections = yield* ClientConnections;
  if (connections.kind(connectionId) !== "desktop")
    return yield* new SessionChatError({ operation: "prompt", message: antigravityDesktopOnly });
  if (
    input.attachments.length ||
    input.crossSession ||
    input.responseMode === "voice" ||
    input.artifactPresentation ||
    delivery !== "prompt" ||
    parseCrossSessionMessage(input.text)
  )
    return yield* new SessionChatError({
      operation: "prompt",
      message:
        "This model supports plain-text messages only. Remove attachments or choose another model for voice, artifacts, or queued input.",
    });
  const projectChat = isProjectChatSessionId(input.sessionId);
  const targetKind =
    handle.profile === "ProjectSession"
      ? "ProjectSession"
      : handle.profile === "CakeChatSession" &&
          (projectChat || input.sessionId === CAKE_CHAT_SESSION_ID)
        ? "CakeChatSession"
        : undefined;
  if (!targetKind || !handle.antigravity)
    return yield* new SessionChatError({
      operation: "antigravity",
      message: antigravityDesktopOnly,
    });
  // Remote desktop sockets are desktop-class but have no native document.
  // A local Project Chat send cannot silently become a text-only send after loss.
  const bridgeTurn =
    projectChat &&
    (nativeDocument !== undefined || connections.nativeId(connectionId) !== undefined);
  const cakeBridgeOwnerSignal = bridgeTurn ? nativeDocument : undefined;
  const unavailable = () =>
    new SessionChatError({
      operation: "antigravity",
      message:
        "The requesting Cake window lost its Project Chat bridge. Send a new turn after the window reloads.",
    });
  if (bridgeTurn && (!cakeBridgeOwnerSignal || cakeBridgeOwnerSignal.aborted))
    return yield* unavailable();
  const coordinator = yield* RendererRequestCoordinator;
  yield* coordinator
    .bind({ _tag: targetKind, sessionId: input.sessionId }, connectionId)
    .pipe(asPromptError);
  yield* coordinator.requireDesktopConnection(input.sessionId, connectionId).pipe(asPromptError);
  const run = makePiCallbackExecutor(yield* Effect.context<RendererRequestCoordinator>());
  if (cakeBridgeOwnerSignal?.aborted) return yield* unavailable();
  const turnId = yield* handle
    .antigravity(input.text, input.renderUserMessageAsMarkdown, {
      cakeBridgeOwnerSignal,
      automaticTitle: input.automaticTitle,
      admissionId: input.clientId,
      async permission(request, signal) {
        const bridgeConsent = request.kind === "cake-operation";
        if (connections.kind(connectionId) !== "desktop") return undefined;
        if (bridgeConsent) {
          if (!cakeBridgeOwnerSignal || cakeBridgeOwnerSignal.aborted) return undefined;
          signal = AbortSignal.any([signal, cakeBridgeOwnerSignal]);
        }
        const consent = coordinator.requireDesktopConnection(input.sessionId, connectionId).pipe(
          Effect.andThen(
            coordinator.requestUiForConnection(
              connectionId,
              input.sessionId,
              {
                kind: "select",
                title: bridgeConsent ? "Cake operation and export" : "Antigravity permission",
                message: request.description,
                options: [
                  { id: "deny", label: "Deny" },
                  ...(request.canAllowOnce ? [{ id: "allow", label: "Allow once" }] : []),
                ],
                signal,
                timeout: 120_000,
              },
              targetKind,
            ),
          ),
        );
        const decision = await run(
          bridgeConsent
            ? consent.pipe(
                Effect.catchTag("RendererRequestCoordinatorError", () => Effect.succeed(undefined)),
              )
            : consent,
          { signal },
        );
        if (bridgeConsent && signal.aborted) return undefined;
        return decision === "allow" || decision === "deny" ? decision : undefined;
      },
    })
    .pipe(asPromptError);
  return TurnId.make(turnId);
});
