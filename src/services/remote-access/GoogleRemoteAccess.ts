import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { OAuth2Client } from "google-auth-library";
import { Option, Schema } from "effect";

const loginCookie = "__Host-cake-login";
const sessionCookie = "__Host-cake-session";
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const flowLifetime = 10 * 60 * 1000;
const token = () => randomBytes(32).toString("base64url");
const Identity = Schema.Struct({
  sub: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  email: Schema.NonEmptyString.check(Schema.isMaxLength(254)),
  email_verified: Schema.Literal(true),
  nonce: Schema.NonEmptyString,
});

export interface GoogleAccountBinding {
  readonly email: string;
  readonly subject: string;
}

const GoogleIdentityClaims = Schema.Struct({
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
  email_verified: Schema.optionalKey(Schema.Boolean),
  nonce: Schema.optionalKey(Schema.String),
});
export interface GoogleIdentityClaims extends Schema.Schema.Type<typeof GoogleIdentityClaims> {}

export interface GoogleRemoteAccessOptions {
  readonly clientId: string;
  readonly origin: string;
  readonly allowedEmails: ReadonlyArray<string>;
  /** Durable, serialized binding. Must reject removed accounts and conflicting subjects. */
  readonly bindAccount: (account: GoogleAccountBinding) => Promise<void>;
  readonly verifyIdentity?: (credential: string) => Promise<GoogleIdentityClaims | undefined>;
  readonly now?: () => number;
}

const cookie = (request: IncomingMessage, name: string) => {
  const matches = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]?.slice(name.length + 1) : undefined;
};
const equal = (a: string | undefined, b: string | undefined) =>
  !!a &&
  !!b &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const setCookie = (name: string, value: string, seconds: number, sameSite: "Lax" | "None") =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${seconds}`;
const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** Listener-owned authentication boundary. Registries are authoritative ephemeral login/session
 * state, not caches. Restart/disable revokes all sessions. Socket lifetime follows its session.
 * Google receives only an OIDC sign-in request; Cake never requests API or refresh tokens.
 */
export function makeGoogleRemoteAccess(options: GoogleRemoteAccessOptions) {
  const now = options.now ?? Date.now;
  let allowed = new Set(options.allowedEmails.map((email) => email.toLowerCase()));
  const flows = new Map<string, number>();
  const sessions = new Map<
    string,
    {
      email: string;
      expires: number;
      sockets: Set<Socket>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const client = new OAuth2Client(options.clientId);
  const verifyIdentity =
    options.verifyIdentity ??
    (async (credential: string) => {
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: options.clientId,
      });
      return Option.getOrUndefined(
        Schema.decodeUnknownOption(GoogleIdentityClaims)(ticket.getPayload()),
      );
    });
  const revoke = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    for (const socket of session.sockets) socket.destroy();
  };
  const sessionFor = (request: IncomingMessage) => {
    const id = cookie(request, sessionCookie);
    const session = id && sessions.get(id);
    if (!session) return undefined;
    if (session.expires <= now() || !allowed.has(session.email)) {
      revoke(id);
      return undefined;
    }
    return session;
  };
  const redirect = (response: ServerResponse, location: string) => {
    response.writeHead(303, { Location: location });
    response.end();
  };
  const deny = (response: ServerResponse, status = 403) => {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      "Sign-in denied. Ask the host owner to check the allowed Google accounts, then sign in again.",
    );
  };

  return {
    /** Invoked after exact Host/Origin validation, before ANY application route. */
    async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      if (request.url === "/auth/login" && request.method === "GET") {
        for (const [id, expires] of flows) if (expires <= now()) flows.delete(id);
        // Abandoned anonymous flows must not lock everyone else out of sign-in.
        const oldest = flows.keys().next();
        if (flows.size >= 256 && !oldest.done) flows.delete(oldest.value);
        const nonce = token();
        flows.set(nonce, now() + flowLifetime);
        response.setHeader(
          "Set-Cookie",
          setCookie(loginCookie, nonce, flowLifetime / 1000, "None"),
        );
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src https://accounts.google.com/gsi/client; frame-src https://accounts.google.com; connect-src https://accounts.google.com/gsi/; style-src https://accounts.google.com/gsi/style; base-uri 'none'; form-action https://accounts.google.com 'self'; frame-ancestors 'none'",
        );
        response.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Cake</title><body><main><h1>Sign in to Cake</h1><script src="https://accounts.google.com/gsi/client" async></script><div id="g_id_onload" data-client_id="${escapeAttribute(options.clientId)}" data-login_uri="${escapeAttribute(options.origin)}/auth/google/callback" data-ux_mode="redirect" data-nonce="${nonce}" data-auto_prompt="false"></div><div class="g_id_signin" data-type="standard" data-theme="outline" data-size="large"></div></main></body></html>`,
        );
        return true;
      }
      if (request.url === "/auth/google/callback" && request.method === "POST") {
        const nonce = cookie(request, loginCookie);
        const expires = nonce && flows.get(nonce);
        // Single-use browser-bound nonce plus Google's required double-submit CSRF check.
        if (nonce) flows.delete(nonce);
        response.setHeader("Set-Cookie", setCookie(loginCookie, "", 0, "None"));
        if (
          !nonce ||
          !expires ||
          expires <= now() ||
          request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded"
        ) {
          deny(response);
          return true;
        }
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > 16384) {
              deny(response, 413);
              return true;
            }
            chunks.push(bytes);
          }
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          if (
            body.getAll("g_csrf_token").length !== 1 ||
            body.getAll("credential").length !== 1 ||
            !equal(cookie(request, "g_csrf_token"), body.get("g_csrf_token") ?? undefined)
          ) {
            deny(response);
            return true;
          }
          const identity = Schema.decodeUnknownOption(Identity)(
            await verifyIdentity(body.get("credential") ?? ""),
          );
          if (Option.isNone(identity) || !equal(identity.value.nonce, nonce)) {
            deny(response);
            return true;
          }
          const email = identity.value.email.toLowerCase();
          if (!allowed.has(email)) {
            deny(response);
            return true;
          }
          await options.bindAccount({ email, subject: identity.value.sub });
          // Authorization may have changed while Google verification/durable binding was pending.
          if (!allowed.has(email) || response.destroyed) {
            deny(response);
            return true;
          }
          const previous = cookie(request, sessionCookie);
          if (previous) revoke(previous);
          // Bound personal-host memory use; signing in again rotates old sessions at the cap.
          if (sessions.size >= 128) {
            const oldest = sessions.keys().next().value;
            if (oldest) revoke(oldest);
          }
          const id = token();
          const timer = setTimeout(() => revoke(id), sessionLifetime);
          timer.unref();
          sessions.set(id, { email, expires: now() + sessionLifetime, sockets: new Set(), timer });
          response.setHeader("Set-Cookie", [
            setCookie(loginCookie, "", 0, "None"),
            setCookie(sessionCookie, id, sessionLifetime / 1000, "Lax"),
          ]);
          redirect(response, "/");
        } catch {
          // Never return Google's token, account details, or verifier error to public clients.
          deny(response);
        }
        return true;
      }
      if (request.url === "/auth/logout" && request.method === "POST") {
        if (request.headers.origin !== options.origin) {
          deny(response);
          return true;
        }
        const id = cookie(request, sessionCookie);
        if (id) revoke(id);
        response.setHeader("Set-Cookie", setCookie(sessionCookie, "", 0, "Lax"));
        redirect(response, "/auth/login");
        return true;
      }
      if (!sessionFor(request)) {
        if (
          request.method === "GET" &&
          (request.url === "/" || request.headers.accept?.includes("text/html"))
        )
          redirect(response, "/auth/login");
        else deny(response, 401);
        return true;
      }
      if (request.url === "/auth/session" && request.method === "GET") {
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    },
    authorizeUpgrade(request: IncomingMessage) {
      const session = sessionFor(request);
      if (!session) return false;
      session.sockets.add(request.socket);
      request.socket.once("close", () => session.sockets.delete(request.socket));
      return true;
    },
    setAllowedEmails(emails: ReadonlyArray<string>) {
      allowed = new Set(emails.map((email) => email.toLowerCase()));
      for (const [id, session] of sessions) if (!allowed.has(session.email)) revoke(id);
    },
    close() {
      allowed.clear();
      flows.clear();
      for (const id of sessions.keys()) revoke(id);
    },
  };
}
export type GoogleRemoteAccess = ReturnType<typeof makeGoogleRemoteAccess>;
