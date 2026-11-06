/** Host capability applied at publication, never retained in immutable browser output. */
export function withInlineWidgetLinks(document: string, token: string): string {
  const bootstrap = `<script>
(() => {
  const send = (type, value) => parent.postMessage({ source: "cake-inline-widget", token: ${JSON.stringify(token)}, type, value }, "*");
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
})();
</script>`;
  // Compiler-owned shells have one head; insert before authored body scripts run.
  return document.replace("</head>", `${bootstrap}</head>`);
}
