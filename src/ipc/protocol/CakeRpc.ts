import { BackendRpc } from "./BackendRpc";
import { DictationRpc } from "./DictationRpc";
import { SpeechOutputRpc } from "./SpeechOutputRpc";
import { DesktopHostRpc } from "./DesktopHostRpc";
import { BrowserRpc } from "./BrowserRpc";
import { DesktopSharingRpc } from "./DesktopSharingRpc";
import { ElectronRpc } from "./ElectronRpc";
import { NativeAttachmentsRpc } from "./NativeAttachmentsRpc";
import { WindowStateRpc } from "./WindowStateRpc";
import { NativeWidgetCaptureRpc } from "./WidgetCaptureRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { VsCodeViewRpc } from "./VsCodeRpc";

export { FoundationFailure } from "./FoundationRpc";

/** Native capabilities extend the shared backend; they are never exposed remotely. */
export const DesktopRpc = DictationRpc.merge(
  SpeechOutputRpc,
  DesktopHostRpc,
  BrowserRpc,
  ElectronRpc,
  DesktopSharingRpc,
  NativeAttachmentsRpc,
  WindowStateRpc,
  NativeWidgetCaptureRpc,
  VsCodeViewRpc,
).middleware(RendererConnectionMiddleware);

export const CakeRpc = BackendRpc.merge(DesktopRpc);
