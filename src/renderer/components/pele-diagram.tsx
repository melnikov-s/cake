import { useContext, useEffect, useId, useRef, useState } from "react";
import type { Zoom } from "pele/core";
import { CodeBlockCopyButton, type CustomRendererProps } from "streamdown";
import { IconButton } from "@/components/ui/icon-button";
import { ResetZoomIcon, ZoomInIcon, ZoomOutIcon } from "@/components/ui/icons";
import { Callout } from "@/components/ui/callout";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { LoadingState } from "@/components/ui/loading-state";
import { DiagramContext } from "../lib/diagram-context";
import { isDiagramHref, requestDiagram, sanitizeDiagram } from "../lib/diagram-rendering";
import { streamingCodeMarker } from "./ai-elements/markdown-code-block";

/** One renderer for chat fences, artifacts and fullscreen. Only sanitized SVG
 * enters the DOM; React owns controls and errors, Pele owns canvas gestures. */
export function PeleDiagram({
  code,
  isIncomplete = false,
  meta,
  fullscreen = false,
}: Pick<CustomRendererProps, "code" | "meta"> & { isIncomplete?: boolean; fullscreen?: boolean }) {
  const { navigate, openFullscreen } = useContext(DiagramContext);
  const changing = isIncomplete || !!meta?.split(/\s+/).includes(streamingCodeMarker);
  const source = code.startsWith(`${streamingCodeMarker}\n`)
    ? code.slice(streamingCodeMarker.length + 1)
    : code;
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const zoom = useRef<Zoom | undefined>(undefined);
  const idPrefix = `cake-diagram-${useId().replace(/[^a-z0-9_-]/gi, "")}`;
  const [width, setWidth] = useState<number>();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const next = Math.round(
        element.getBoundingClientRect().width -
          (parseFloat(style.paddingLeft) || 0) -
          (parseFloat(style.paddingRight) || 0),
      );
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width === undefined || changing) return;
    const element = container.current;
    if (!element) return;
    const abort = new AbortController();
    setError(undefined);
    setSvg(undefined);
    const render = async () => {
      await document.fonts?.ready;
      if (abort.signal.aborted) return;
      const style = getComputedStyle(element);
      const result = await requestDiagram(
        {
          source,
          maxWidth: width,
          fontFamily: style.fontFamily,
          fontFamilyMono: style.getPropertyValue("--font-mono").trim() || "monospace",
          idPrefix,
        },
        abort.signal,
      );
      if (!abort.signal.aborted) setSvg(sanitizeDiagram(result));
    };
    void render().catch((reason: unknown) => {
      if (!abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => abort.abort();
  }, [source, width, changing, idPrefix]);

  useEffect(() => {
    if (!svg || !canvas.current || changing) return;
    const element = canvas.current;
    let active = true;
    let behavior: Zoom | undefined;
    void import("pele/core").then(({ enableZoom }) => {
      if (!active) return;
      behavior = enableZoom(element, { always: true, controls: false });
      zoom.current = behavior;
    });
    return () => {
      active = false;
      behavior?.destroy();
      zoom.current = undefined;
    };
  }, [svg, changing]);

  return (
    <div
      ref={container}
      data-diagram="pele"
      className={
        fullscreen
          ? "flex size-full min-w-0 flex-col p-6"
          : "group/diagram relative my-4 min-w-0 w-full"
      }
      onAuxClickCapture={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest("a");
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href");
        if (href && isDiagramHref(href)) navigate?.(href);
      }}
    >
      <div className="mb-2 flex items-center justify-end gap-1 text-muted-foreground">
        {svg && !changing && !error && (
          <>
            <IconButton tooltip="Zoom in" onClick={() => zoom.current?.zoomBy(1.25)}>
              <ZoomInIcon />
            </IconButton>
            <IconButton tooltip="Zoom out" onClick={() => zoom.current?.zoomBy(0.8)}>
              <ZoomOutIcon />
            </IconButton>
            <IconButton tooltip="Reset zoom" onClick={() => zoom.current?.reset()}>
              <ResetZoomIcon />
            </IconButton>
          </>
        )}
        <CodeBlockCopyButton code={source} />
        {!fullscreen && svg && !changing && !error && openFullscreen && (
          <FullscreenButton
            label="View diagram fullscreen"
            onClick={() => openFullscreen(source)}
          />
        )}
      </div>
      {changing ? (
        <>
          <p className="text-xs text-muted-foreground" role="status">
            Waiting for diagram…
          </p>
          <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap">{source}</pre>
        </>
      ) : error ? (
        <>
          <Callout variant="error">
            <strong>Diagram could not render</strong>
            <span className="text-xs">{error}</span>
          </Callout>
          <pre className="mt-2 overflow-auto font-mono text-xs whitespace-pre-wrap">{source}</pre>
        </>
      ) : svg ? (
        <div
          ref={canvas}
          className={
            fullscreen
              ? "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
              : "relative flex min-h-24 w-full items-center justify-center overflow-hidden"
          }
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <LoadingState label="Rendering diagram" />
      )}
    </div>
  );
}
