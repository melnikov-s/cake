import { Effect } from "effect";
import { SessionChatError } from "../../domain/conversations/conversation-data";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { PiProviderAuthError } from "../../services/pi/model-data";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import { PiModels, type PiProviderAuthInteraction } from "../../services/pi/PiModels";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { ProviderAuthRpc } from "../protocol/ProviderAuthRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

/** The requesting transport connection, not the last observer of a session, owns the dialog. */
const login = Effect.fn("ProviderAuth.login")(function* (
  provider: string,
  authType: "api_key" | "oauth",
  sessionId?: string,
) {
  const models = yield* PiModels;
  const requests = yield* RendererRequestCoordinator;
  const clientEvents = yield* ClientEvents;
  const { connectionId } = yield* RendererConnection;
  const adapterContext = yield* Effect.context<RendererRequestCoordinator>();
  const runAdapter = makePiCallbackExecutor(adapterContext);
  const requestScopeId = `provider-settings:${connectionId}:${crypto.randomUUID()}`;
  let authorizationUrl: string | undefined;
  const interaction: PiProviderAuthInteraction = {
    request: (request) =>
      runAdapter(
        requests.requestUiForConnection(connectionId, requestScopeId, {
          ...request,
          message:
            request.kind === "manual_code" && authorizationUrl
              ? `${request.message}\n\nSign-in URL: ${authorizationUrl}\nIf your browser cannot reach the server's callback address, copy the final redirect URL and paste it here.`
              : request.message,
          title: `Provider authentication · ${provider}`,
        }),
        request.signal,
      ),
    notify: (notice) => {
      if (notice.type === "auth_url") authorizationUrl = notice.url;
      const message = sessionId
        ? { type: "provider-auth-notice" as const, provider, sessionId, notice }
        : { type: "provider-auth-notice" as const, provider, notice };
      if (!clientEvents.sendTo(connectionId, message))
        throw new Error("The initiating client disconnected during provider authentication");
      // Pi's callback server stays on the backend. The initiating device displays
      // URLs and codes; Pi's manual_code prompt handles redirect URLs where supported.
    },
  };
  yield* models.login(provider, authType, interaction);
  // Existing session runtimes and the sessionless picker share Pi's credential file,
  // but each runtime must reproject its own model/auth state after Pi writes it.
  yield* Effect.flatMap(CakeSessionRuntimes, (sessions) => sessions.refreshModels()).pipe(
    Effect.mapError(
      (error) => new PiProviderAuthError({ operation: "login", provider, message: error.message }),
    ),
  );
});

const logout = Effect.fn("ProviderAuth.logout")(function* (provider: string) {
  yield* Effect.flatMap(PiModels, (models) => models.logout(provider));
  yield* Effect.flatMap(CakeSessionRuntimes, (sessions) => sessions.refreshModels()).pipe(
    Effect.mapError(
      (error) => new PiProviderAuthError({ operation: "logout", provider, message: error.message }),
    ),
  );
});

const verifySession = Effect.fn("ProviderAuth.verifySession")(function* (sessionId: string) {
  const sessions = yield* CakeSessionRuntimes;
  yield* Effect.scoped(sessions.acquireSession(sessionId));
});

const asSessionError = (operation: "login" | "logout") =>
  Effect.mapError(
    (error: { readonly message: string }) =>
      new SessionChatError({ operation, message: error.message }),
  );

export const providerAuthHandlers = ProviderAuthRpc.of({
  "models.login": ({ provider, authType }) => login(provider, authType),
  "models.logout": ({ provider }) => logout(provider),
  "sessionChats.login": ({ provider, authType, sessionId }) =>
    Effect.gen(function* () {
      yield* verifySession(sessionId);
      yield* login(provider, authType, sessionId);
    }).pipe(asSessionError("login")),
  "sessionChats.logout": ({ provider, sessionId }) =>
    Effect.gen(function* () {
      yield* verifySession(sessionId);
      yield* logout(provider);
    }).pipe(asSessionError("logout")),
});
