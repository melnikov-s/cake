import { expect, it, vi } from "vitest";
import { checkBrowserAuthentication } from "../../../src/renderer/client/BrowserAuthentication";

it("navigates to sign-in only when the host confirms an expired or revoked session", async () => {
  const signal = new AbortController().signal;
  const signIn = vi.fn();
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
  await checkBrowserAuthentication(signal, request, signIn);
  expect(request).toHaveBeenCalledWith("/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  expect(signIn).toHaveBeenCalledOnce();
});

it("keeps normal reconnect and drafts on network failure, valid sessions or disposal", async () => {
  const owner = new AbortController();
  const signIn = vi.fn();
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  await checkBrowserAuthentication(owner.signal, request, signIn);
  await checkBrowserAuthentication(owner.signal, request, signIn);
  owner.abort();
  await checkBrowserAuthentication(owner.signal, request, signIn);
  expect(signIn).not.toHaveBeenCalled();
});
