/** A WebSocket failure alone cannot distinguish offline from revoked authentication.
 * Check only on disconnect, never poll, and leave ordinary network recovery alone.
 * Browser presentation/drafts already persist in sessionStorage across this navigation.
 */
export async function checkBrowserAuthentication(
  signal: AbortSignal,
  request: typeof fetch = fetch,
  signIn: () => void = () => window.location.assign("/auth/login"),
) {
  try {
    const response = await request("/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!signal.aborted && response.status === 401) signIn();
  } catch {
    // An unreachable host is not evidence of logout. Keep drafts and normal reconnect UI.
  }
}
