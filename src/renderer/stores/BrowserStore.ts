import { Store } from "r-state-tree";
import type { Attachment } from "../../ipc/session-contract";
import type { ProjectSessionPresentationMode } from "../../domain/project-sessions/project-session-presentation";
import type { BrowserStateSnapshot } from "../client/Client";
import type { StoreEvent } from "../events/StoreEvent";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

export interface BrowserStoreProps {
  sessionId(): string | undefined;
  presentationMode(): ProjectSessionPresentationMode;
  setPresentationMode(mode: ProjectSessionPresentationMode): void;
  chatSidebarVisible(): boolean;
  chatSidebarWidth(): number;
  setChatSidebarWidth(width: number): void;
  appendAttachment(attachment: Attachment): void;
  enterProjectSidebarMode(): void;
  leaveProjectSidebarMode(): void;
}

export interface BrowserViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY_VIEWPORT: BrowserViewport = { x: 0, y: 0, width: 0, height: 0 };

/** Owns Browser Mode presentation, navigation, inspection, and native-view geometry. */
export class BrowserStore extends Store<BrowserStoreProps> {
  visible = false;
  url = "http://localhost:3000";
  address = this.url;
  title = "";
  loading = false;
  canGoBack = false;
  canGoForward = false;
  inspecting = false;
  addressEditing = false;
  error: string | undefined;
  errorDetails: string | undefined;
  measuredBounds: BrowserViewport | undefined;
  private openedSessionId: string | undefined;

  get browser() {
    return ClientContext.consume(this)!.browser;
  }

  get sessionId() {
    return this.props.sessionId();
  }

  get chatSidebarVisible() {
    return this.props.chatSidebarVisible();
  }

  get chatSidebarWidth() {
    return this.props.chatSidebarWidth();
  }

  get nativeViewBounds() {
    const rect = this.measuredBounds ?? EMPTY_VIEWPORT;
    return {
      sessionId: this.sessionId ?? "",
      visible:
        this.visible &&
        this.openedSessionId === this.sessionId &&
        rect.width > 0 &&
        rect.height > 0,
      ...rect,
    };
  }

  constructor(props: BrowserStore["props"]) {
    super(props);
    this.reaction(
      () => JSON.stringify(this.nativeViewBounds),
      () => void this.pushBounds(),
    );
  }

  async show() {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.props.setPresentationMode("browser");
    if (!this.visible) this.props.enterProjectSidebarMode();
    this.visible = true;
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const state = await this.browser.open(sessionId, undefined, { signal: this.signal });
      if (this.signal.aborted || this.sessionId !== sessionId) return;
      this.openedSessionId = sessionId;
      this.applyState(state);
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async restore() {
    if (this.props.presentationMode() === "browser") await this.show();
  }

  showAgentBrowser() {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.props.setPresentationMode("browser");
    if (!this.visible) this.props.enterProjectSidebarMode();
    this.visible = true;
    this.openedSessionId = sessionId;
    void this.refresh();
  }

  async refresh() {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      this.applyState(await this.browser.state(sessionId, { signal: this.signal }));
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  setAddress(value: string) {
    this.address = value;
  }

  beginAddressEditing() {
    this.addressEditing = true;
  }

  endAddressEditing() {
    this.addressEditing = false;
  }

  async navigate(address = this.address) {
    const sessionId = this.sessionId;
    if (!sessionId || !address.trim()) return;
    this.address = address;
    this.addressEditing = false;
    try {
      this.applyState(await this.browser.navigate(sessionId, address, { signal: this.signal }));
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async action(action: "back" | "forward" | "reload" | "stop") {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      this.applyState(await this.browser.action(sessionId, action, { signal: this.signal }));
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async inspect() {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      this.applyState(await this.browser.inspect(sessionId, { signal: this.signal }));
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  receive(event: StoreEvent) {
    const sessionId = this.sessionId;
    if (!sessionId || !("sessionId" in event) || event.sessionId !== sessionId) return;
    if (event.type === "browser-state-changed") {
      this.applyState(event);
      return;
    }
    if (event.type === "browser-element-selected") {
      this.inspecting = false;
      this.props.appendAttachment({
        kind: "browser",
        name: `${event.tagName}${event.selector ? ` ${event.selector}` : ""}`.slice(0, 512),
        url: event.url,
        tagName: event.tagName,
        selector: event.selector,
        outerHTML: event.outerHTML,
        text: event.text,
      });
    }
  }

  setMeasuredBounds(bounds: BrowserViewport | undefined) {
    this.measuredBounds = bounds;
  }

  setChatSidebarWidth(width: number) {
    this.props.setChatSidebarWidth(width);
  }

  suspend() {
    if (this.visible) this.props.leaveProjectSidebarMode();
    this.visible = false;
  }

  private applyState(state: BrowserStateSnapshot) {
    if (state.sessionId !== this.sessionId) return;
    this.url = state.url;
    if (!this.addressEditing) this.address = state.url;
    this.title = state.title;
    this.loading = state.loading;
    this.canGoBack = state.canGoBack;
    this.canGoForward = state.canGoForward;
    this.inspecting = state.inspecting;
  }

  private async pushBounds() {
    const bounds = this.nativeViewBounds;
    if (!bounds.sessionId) return;
    try {
      this.applyState(await this.browser.updateBounds(bounds, { signal: this.signal }));
    } catch {
      // A superseded geometry update is harmless; the next derived change pushes again.
    }
  }

  private setError(error: unknown) {
    const described = describeError(error, "Browser mode");
    this.error = described.message;
    this.errorDetails = described.details;
  }
}
