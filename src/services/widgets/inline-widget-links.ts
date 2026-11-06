/** Shared by HTML, React, and Session Plugin documents, before authored code runs. */
export const inlineWidgetLinks = `
  const openLink = (value) => {
    if (value == null || String(value).trim() === "") return;
    const url = new URL(String(value), document.baseURI);
    send("open-link", { url: url.href });
  };
  // A host URL-open operation, not popup/WindowProxy emulation. Never give authored
  // code an opener or navigate Cake's own document, regardless of target/features.
  globalThis.open = (url) => { openLink(url); return null; };
  addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    if (!anchor || anchor.hasAttribute("download")) return;
    const target = anchor.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target");
    const href = anchor.getAttribute("href");
    if (target?.toLowerCase() !== "_blank" || !href || href.startsWith("#")) return;
    event.preventDefault();
    openLink(anchor.href);
  });
`;
