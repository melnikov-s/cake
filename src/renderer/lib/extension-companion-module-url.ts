const publishedModuleUrl = /^cake-extension:\/\/module\/([0-9a-f]{64})$/;

/** Only published Cake module capabilities may become executable browser URLs. */
export function extensionCompanionModuleUrl(
  moduleUrl: string,
  location: Pick<Location, "protocol" | "origin">,
): string | undefined {
  const token = publishedModuleUrl.exec(moduleUrl)?.[1];
  if (!token) return undefined;
  if (location.protocol !== "http:" && location.protocol !== "https:") return moduleUrl;
  return `${location.origin}/widget-assets/module/${token}`;
}
