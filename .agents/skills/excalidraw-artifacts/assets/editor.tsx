import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as NativeLibrary from "@excalidraw/excalidraw";
type ExcalidrawLibrary = typeof NativeLibrary;
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import assetBase from "@cake/assets/@excalidraw/excalidraw/dist/prod/";
import { useArtifactState } from "@cake/artifact-sdk";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string;
  }
}

// Ordinary skill code, not a Cake library integration. The generic compiler
// retains CSS, fonts, and runtime resources with the accepted browser output.
window.EXCALIDRAW_ASSET_PATH = assetBase;
// Native font descriptors capture their URLs during module evaluation. A static
// value import would initialize them before this assignment and leak CDN URLs
// into SVG export even though the editor CSS fonts loaded locally.
const nativeLibrary = import("@excalidraw/excalidraw");

type Scene = {
  type: "excalidraw";
  version: number;
  source: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  selection?: AppState["selectedElementIds"];
  skeleton?: Parameters<ExcalidrawLibrary["convertToExcalidrawElements"]>[0];
};

// Empty-storage default only. New scene data and saved state arrive through the
// generic artifact SDK; do not modify renderer source to create a document.
const initialScene: Scene = {
  type: "excalidraw",
  version: 2,
  source: "artifact",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20, gridModeEnabled: false },
  files: {},
};

type SaveFlight = { scene: Scene; signature: string; version: number; epoch: number };
type EditorState = {
  base: Scene;
  observedVersion: number;
  epoch: number;
  ready: boolean;
  applying: boolean;
  paused: boolean;
  mounted: boolean;
  lastScene: string;
  pending: Scene | null;
  flight: SaveFlight | null;
  acknowledged: { signature: string; version: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
};

// Property order is not document identity (host JSON edits can reorder keys).
function signature(value: Scene): string {
  return JSON.stringify(value, (_key, item) =>
    // This is JSON key-order normalization of SDK/library-owned scene data,
    // not a runtime domain discriminator or input parser.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

function snapshot(
  base: Scene,
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  serializeAsJSON: ExcalidrawLibrary["serializeAsJSON"],
): Scene {
  const native = JSON.parse(serializeAsJSON(elements, appState, files, "local"));
  const persistentBase = { ...base };
  delete persistentBase.skeleton;
  const originals = new Map(base.elements.map((element) => [element.id, element]));
  // Native initialData restoration treats null/[] empty bindings interchangeably.
  // That mount-time default is not a user edit to an unrelated stored object.
  const persistentElements = elements.map((element) =>
    originals.get(element.id)?.boundElements === null && element.boundElements?.length === 0
      ? { ...element, boundElements: null }
      : element,
  );
  // The file-export serializer intentionally drops tombstones and unused image
  // files. Live storage retains them for native undo, plus unknown document
  // metadata/customData. Add only explicitly JSON-safe useful UI settings.
  return JSON.parse(
    JSON.stringify({
      ...persistentBase,
      elements: persistentElements,
      files: { ...base.files, ...files },
      appState: {
        ...base.appState,
        ...native.appState,
        theme: appState.theme,
        name: appState.name,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom,
        selectedGroupIds: appState.selectedGroupIds,
        editingGroupId: appState.editingGroupId,
        exportBackground: appState.exportBackground,
        exportEmbedScene: appState.exportEmbedScene,
        exportScale: appState.exportScale,
        exportWithDarkMode: appState.exportWithDarkMode,
      },
      selection: appState.selectedElementIds || {},
    }),
  );
}

// External document edits arrive as JSON, not native editor actions. Let the
// installed library wrap/recenter labels, then persist its normalized result.
function restoreSceneElements(
  scene: Scene,
  localElements: readonly ExcalidrawElement[],
  library: ExcalidrawLibrary,
) {
  const incoming = new Map(scene.elements.map((element) => [element.id, element]));
  const local = new Map(localElements.map((element) => [element.id, element]));
  const restored = library.restoreElements(
    scene.elements.map((element) =>
      element.type === "text" ? { ...element, text: element.originalText } : element,
    ),
    null,
    { repairBindings: true, refreshDimensions: true },
  );
  let normalized = false;
  const elements = restored.map((element) => {
    // Native restoration also normalizes unrelated defaults (for example null
    // empty bindings to []). Keep the stored objects unless their text needs layout.
    if (element.type !== "text" || element.isDeleted) return incoming.get(element.id) ?? element;
    let text = element;
    const container = element.containerId ? incoming.get(element.containerId) : undefined;
    if (
      container &&
      (container.type === "rectangle" ||
        container.type === "ellipse" ||
        container.type === "diamond" ||
        container.type === "arrow")
    ) {
      // Measure only a disposable container/label pair with the public native
      // converter. Never replace existing objects or their bindings with it.
      const measured = library
        .convertToExcalidrawElements(
          [{ ...container, boundElements: [], label: { ...element, text: element.originalText } }],
          { regenerateIds: false },
        )
        .find((candidate) => candidate.id === element.id);
      if (measured?.type === "text")
        text = {
          ...element,
          text: measured.text,
          x: measured.x,
          y: measured.y,
          width: measured.width,
          height: measured.height,
        };
    }
    const source = incoming.get(text.id);
    const previous = local.get(text.id);
    const layoutChanged =
      source?.type === "text" &&
      (text.text !== source.text ||
        text.x !== source.x ||
        text.y !== source.y ||
        text.width !== source.width ||
        text.height !== source.height);
    const unversionedTextEdit =
      previous?.type === "text" &&
      previous.originalText !== text.originalText &&
      text.version <= previous.version;
    if (!layoutChanged && !unversionedTextEdit) return source ?? text;
    normalized = true;
    return library.newElementWith(
      { ...text, version: Math.max(text.version, previous?.version ?? 0) },
      {},
      true,
    );
  });
  return { elements, normalized };
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow the browser to consume the Blob before releasing it. This is the
  // standard sandbox download primitive, not a library-specific host API.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function ExcalidrawArtifact() {
  const [library, setLibrary] = useState<ExcalidrawLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    nativeLibrary.then(
      (loaded) => {
        if (mounted) setLibrary(loaded);
      },
      (cause) => {
        if (mounted) setLoadError(String(cause));
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  if (loadError) return <p role="alert">Cannot load drawing editor: {loadError}</p>;
  if (!library) return <p role="status">Loading drawing editor…</p>;
  return <ExcalidrawEditor library={library} />;
}

function ExcalidrawEditor({ library }: { library: ExcalidrawLibrary }) {
  const { CaptureUpdateAction, Excalidraw, exportToBlob, exportToSvg, serializeAsJSON } = library;
  // Native converters can leave own customData: undefined. postMessage preserves
  // it; normalize the seed as well as snapshots before crossing the JSON boundary.
  const [jsonInitialScene] = useState<Scene>(() => JSON.parse(JSON.stringify(initialScene)));
  const {
    value: stored,
    hydrated,
    version,
    save,
    error,
    reload,
  } = useArtifactState(jsonInitialScene);
  // Only new documents contain skeleton input. Saved native elements are never
  // reconverted: manual edits, IDs, bindings and unknown metadata remain intact.
  const value = useMemo<Scene>(() => {
    if (!stored.skeleton) return stored;
    const { skeleton, ...scene } = stored;
    return JSON.parse(
      JSON.stringify({
        ...jsonInitialScene,
        ...scene,
        elements: library.convertToExcalidrawElements(skeleton, { regenerateIds: false }),
      }),
    );
  }, [stored, library, jsonInitialScene]);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const saveRef = useRef(save);
  const state = useRef<EditorState>({
    base: jsonInitialScene,
    observedVersion: -1,
    epoch: 0,
    ready: false,
    applying: false,
    paused: false,
    mounted: true,
    lastScene: "",
    pending: null,
    flight: null,
    acknowledged: null,
    timer: null,
  });

  const flush = useCallback(async () => {
    const current = state.current;
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    if (!current.ready || current.flight || !current.pending) return;
    const pendingSignature = signature(current.pending);
    if (pendingSignature === signature(current.base)) {
      current.pending = null;
      if (current.mounted) setDirty(false);
      return;
    }
    const flight = {
      scene: current.pending,
      signature: pendingSignature,
      version: current.observedVersion,
      epoch: current.epoch,
    };
    current.pending = null;
    current.flight = flight;
    if (current.mounted) setSaving(true);
    let succeeded = false;
    try {
      const saved = await saveRef.current(flight.scene);
      succeeded = true;
      if (current.epoch === flight.epoch) {
        // React may process the SDK subscription after this Promise settles.
        // Retain the acknowledgment beyond the lifetime of the in-flight save.
        current.acknowledged = { signature: flight.signature, version: saved.version };
        current.paused = false;
        if (current.mounted) {
          setSaveError(null);
          setDirty(
            current.observedVersion < saved.version || current.lastScene !== flight.signature,
          );
        }
      }
    } catch (cause) {
      // Never requeue a stale document after a newer authoritative update. A
      // network/storage failure keeps the latest local edit for explicit retry.
      if (current.epoch === flight.epoch) {
        current.pending ||= flight.scene;
        current.paused = true;
        if (current.mounted) setSaveError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      current.flight = null;
      if (current.mounted) setSaving(false);
      // One CAS at a time. Edits made during a successful save are coalesced,
      // while failures do not produce an unbounded automatic retry loop.
      if (
        (succeeded || current.epoch !== flight.epoch) &&
        current.pending &&
        !current.paused &&
        current.mounted &&
        current.observedVersion > flight.version
      ) {
        current.timer = setTimeout(() => void flush(), 200);
      }
    }
  }, []);

  useLayoutEffect(() => {
    if (!hydrated || !api) return;
    // Bind a new CAS save closure only when its authoritative version is also
    // being applied. Do not expose a fresh version to an older pending canvas
    // snapshot in the interval between render and a passive effect.
    saveRef.current = save;
    const current = state.current;
    if (current.observedVersion >= version) return;
    const incoming = signature(value);
    const ownAcknowledgment =
      (current.flight &&
        current.flight.epoch === current.epoch &&
        version === current.flight.version + 1 &&
        incoming === current.flight.signature) ||
      (current.acknowledged &&
        version === current.acknowledged.version &&
        incoming === current.acknowledged.signature);
    current.observedVersion = version;
    // Retain the input marker only in the comparison base so initialization
    // always saves native elements, even when native layout needs no repair.
    current.base = stored.skeleton ? { ...value, skeleton: stored.skeleton } : value;
    current.acknowledged = null;
    if (ownAcknowledgment) {
      setDirty(current.lastScene !== incoming);
      if (current.pending && !current.flight && !current.paused) {
        current.timer = setTimeout(() => void flush(), 200);
      }
      return;
    }

    const discarded = current.pending !== null || current.flight !== null;
    current.epoch += 1;
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    current.pending = null;
    current.paused = false;
    setDirty(false);
    setSaveError(null);
    if (discarded)
      setNotice("A newer saved drawing replaced pending edits. Review it before continuing.");

    const { elements, normalized } = restoreSceneElements(
      value,
      api.getSceneElementsIncludingDeleted(),
      library,
    );
    const appState = {
      ...api.getAppState(),
      ...value.appState,
      selectedElementIds: value.selection || value.appState.selectedElementIds || {},
    };
    const files = { ...api.getFiles(), ...value.files };
    // Set the expected normalized echo BEFORE calling the API. Both synchronous
    // and later onChange notifications of hydration/agent edits are not saves.
    const normalizedScene = snapshot(value, elements, appState, files, serializeAsJSON);
    current.lastScene = signature(normalizedScene);
    current.applying = true;
    try {
      api.addFiles(Object.values(value.files || {}));
      api.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    } finally {
      current.applying = false;
      current.ready = true;
    }
    if (normalized || stored.skeleton) {
      current.pending = normalizedScene;
      setDirty(true);
      current.timer = setTimeout(() => void flush(), 200);
    }
  }, [api, hydrated, value, stored, version, save, flush, library]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const current = state.current;
      if (!current.ready || current.applying) return;
      const scene = snapshot(current.base, elements, appState, files, serializeAsJSON);
      const nextSignature = signature(scene);
      if (nextSignature === current.lastScene) return;
      current.lastScene = nextSignature;
      current.pending = scene;
      setDirty(true);
      setNotice(null);
      if (current.timer !== null) clearTimeout(current.timer);
      // Preserve errors until a save actually succeeds. The retry button submits
      // the latest local snapshot, not the older failed one.
      if (!current.paused) current.timer = setTimeout(() => void flush(), 200);
    },
    [flush],
  );

  useEffect(() => {
    state.current.mounted = true;
    const onPageHide = () => void flush();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      state.current.mounted = false;
      // Best effort only: closing a frame/app cannot guarantee a host reply.
      // Normal persistence and explicit retry happen while the frame is live.
      void flush();
    };
  }, [flush]);

  const exportDrawing = async (format: "png" | "svg" | "excalidraw") => {
    if (!api) return;
    setExporting(true);
    setExportError(null);
    try {
      const scene = {
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles(),
      };
      if (format === "png") {
        download(await exportToBlob({ ...scene, mimeType: "image/png" }), "drawing.png");
      } else if (format === "svg") {
        const svg = await exportToSvg(scene);
        download(new Blob([svg.outerHTML], { type: "image/svg+xml" }), "drawing.svg");
      } else {
        download(
          new Blob([serializeAsJSON(scene.elements, scene.appState, scene.files, "local")], {
            type: "application/vnd.excalidraw+json",
          }),
          "drawing.excalidraw",
        );
      }
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  const reconnect = async () => {
    try {
      await reload();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Gate the first mount, but do not destroy a user's unsaved native scene when
  // an established connection temporarily fails. Same-version reload leaves
  // it intact; a newer authoritative version follows the external-update path.
  if (!hydrated && !state.current.ready)
    return (
      <main>
        <p role="status">
          {error ? `Could not load drawing: ${String(error)}` : "Loading drawing…"}
        </p>
        {error && (
          <button type="button" onClick={() => void reconnect()}>
            Retry loading drawing
          </button>
        )}
      </main>
    );
  return (
    <main>
      <div style={{ height: 640, width: "100%" }}>
        <Excalidraw
          initialData={{
            ...value,
            appState: {
              ...value.appState,
              selectedElementIds: value.selection || value.appState.selectedElementIds || {},
            },
          }}
          excalidrawAPI={setApi}
          onChange={onChange}
          aiEnabled={false}
          UIOptions={{ canvasActions: { export: { saveFileToDisk: true } } }}
        />
      </div>
      <button
        type="button"
        disabled={saving || !hydrated || Boolean(error)}
        onClick={() => void flush()}
      >
        {saving ? "Saving drawing…" : saveError ? "Retry saving drawing" : "Save drawing"}
      </button>
      <button type="button" disabled={!api || exporting} onClick={() => void exportDrawing("png")}>
        Export PNG
      </button>
      <button type="button" disabled={!api || exporting} onClick={() => void exportDrawing("svg")}>
        Export SVG
      </button>
      <button
        type="button"
        disabled={!api || exporting}
        onClick={() => void exportDrawing("excalidraw")}
      >
        Export drawing
      </button>
      {(saving || dirty) && <p role="status">{saving ? "Saving…" : "Unsaved changes"}</p>}
      {(!hydrated || error) && (
        <button type="button" onClick={() => void reconnect()}>
          Reconnect drawing
        </button>
      )}
      {exportError && <p role="alert">Could not export drawing: {exportError}</p>}
      {notice && <p role="status">{notice}</p>}
      {(error || saveError) && (
        <p role="alert">Could not save drawing: {String(saveError || error)}</p>
      )}
    </main>
  );
}
