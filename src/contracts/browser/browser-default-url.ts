/** Startup location only; never replaces a retained browser page. */
export const DEFAULT_BROWSER_URL = "https://www.google.com/";

export function browserStartupUrl(configured?: string): string {
  return configured?.trim() || DEFAULT_BROWSER_URL;
}
