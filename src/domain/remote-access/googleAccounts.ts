import { Effect } from "effect";
import { DesktopSharingError } from "../../contracts/desktop/desktop-sharing-data";
import type { GoogleAccountBinding } from "../../services/remote-access/GoogleRemoteAccess";
import {
  saveRemoteAccessBindings,
  type RemoteAccessBindings,
} from "../../services/storage/remote-access-bindings";

/** The email is an administrator's invitation; after first use, its Google subject is pinned.
 * Removing and re-adding an email does not transfer approval to a different Google account.
 * The host's sharing lock serializes this operation with allowlist changes and other bindings.
 */
export const bindGoogleAccount = Effect.fn("GoogleAccounts.bind")(function* (
  directory: string,
  bindings: RemoteAccessBindings,
  allowedEmails: ReadonlyArray<string>,
  account: GoogleAccountBinding,
) {
  if (!allowedEmails.some((email) => email.toLowerCase() === account.email))
    return yield* new DesktopSharingError({ message: "Account is no longer allowed." });
  const existing = bindings.find((binding) => binding.email === account.email);
  if (existing) {
    if (existing.subject !== account.subject)
      return yield* new DesktopSharingError({
        message: "Google account identity does not match its approved binding.",
      });
    return bindings;
  }
  const next = [...bindings, account];
  yield* saveRemoteAccessBindings(directory, next);
  return next;
});
