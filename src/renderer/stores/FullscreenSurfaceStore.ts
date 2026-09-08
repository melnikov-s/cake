import { Store } from "r-state-tree";

interface FullscreenSurfaceStoreProps {
  setOpen(surfaceId: string, open: boolean): Promise<void>;
}

/** Coordinates mounted fullscreen surfaces with Electron's native surface controls. */
export class FullscreenSurfaceStore extends Store<FullscreenSurfaceStoreProps> {
  private readonly closeRequests = new Map<string, () => void>();

  open(surfaceId: string, onClose: () => void) {
    this.closeRequests.set(surfaceId, onClose);
    void this.props.setOpen(surfaceId, true).catch(() => undefined);

    return () => {
      if (this.closeRequests.get(surfaceId) === onClose) this.closeRequests.delete(surfaceId);
      void this.props.setOpen(surfaceId, false).catch(() => undefined);
    };
  }

  requestClose(surfaceId: string) {
    this.closeRequests.get(surfaceId)?.();
  }
}
