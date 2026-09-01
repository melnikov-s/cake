export function shouldAllowNavigation(currentUrl: string, nextUrl: string, rendererUrl?: string) {
  if (nextUrl === currentUrl) return true;
  if (!rendererUrl) return false;

  try {
    return new URL(nextUrl).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}
