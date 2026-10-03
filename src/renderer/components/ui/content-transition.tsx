import { Component, createRef, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface ContentTransitionProps {
  contentKey: string;
  requestedKey?: string;
  ready?: boolean;
  enabled?: boolean;
  className?: string;
  children: ReactNode;
}

/** Commits live content immediately; only its presentation waits for the outgoing fade. */
export class ContentTransition extends Component<
  ContentTransitionProps,
  Record<string, never>,
  HTMLDivElement | null
> {
  private readonly contentRef = createRef<HTMLDivElement>();
  private readonly outgoingRef = createRef<HTMLDivElement>();
  private exit: Animation | undefined;
  private entrance: Animation | undefined;
  private waiting = false;

  private target(props = this.props) {
    return props.requestedKey ?? props.contentKey;
  }

  getSnapshotBeforeUpdate(previous: ContentTransitionProps): HTMLDivElement | null {
    if (
      !this.props.enabled ||
      !previous.enabled ||
      this.target(previous) === this.target() ||
      this.waiting ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return null;
    const content = this.contentRef.current;
    if (!content) return null;
    // Capture before React removes the outgoing transcript. No second Chat or
    // retained Store: just disposable, inert DOM for the brief exit animation.
    // SAFETY: cloneNode preserves the tag of the div owned by contentRef.
    const snapshot = content.cloneNode(true) as HTMLDivElement;
    const originals = content.querySelectorAll<HTMLElement>("*");
    const copies = snapshot.querySelectorAll<HTMLElement>("*");
    originals.forEach((element, index) => {
      const copy = copies[index]!;
      copy.removeAttribute("id");
      if (element.scrollTop || element.scrollLeft) {
        copy.dataset.transitionScrollTop = String(element.scrollTop);
        copy.dataset.transitionScrollLeft = String(element.scrollLeft);
      }
    });
    snapshot.inert = true;
    snapshot.setAttribute("aria-hidden", "true");
    return snapshot;
  }

  componentDidUpdate(
    previous: ContentTransitionProps,
    _state: Readonly<Record<string, never>>,
    snapshot: HTMLDivElement | null,
  ) {
    const content = this.contentRef.current;
    const outgoing = this.outgoingRef.current;
    if (!content || !outgoing) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!this.props.enabled || reduced) {
      this.clearAnimations();
      this.waiting = false;
      content.classList.remove("opacity-0");
      content.inert = false;
      content.removeAttribute("aria-hidden");
      return;
    }
    if (this.target(previous) !== this.target()) {
      this.clearAnimations();
      this.waiting = true;
      content.classList.add("opacity-0");
      content.inert = true;
      content.setAttribute("aria-hidden", "true");
      if (snapshot) {
        outgoing.append(snapshot);
        for (const element of snapshot.querySelectorAll<HTMLElement>(
          "[data-transition-scroll-top]",
        )) {
          element.scrollTop = Number(element.dataset.transitionScrollTop);
          element.scrollLeft = Number(element.dataset.transitionScrollLeft);
          delete element.dataset.transitionScrollTop;
          delete element.dataset.transitionScrollLeft;
        }
        const exit = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 40,
          easing: "ease-out",
        });
        this.exit = exit;
        exit.onfinish = () => {
          outgoing.replaceChildren();
          this.exit = undefined;
          this.revealIfReady();
        };
      }
    }
    this.revealIfReady();
  }

  private revealIfReady() {
    if (
      !this.waiting ||
      this.exit ||
      this.props.ready === false ||
      this.props.contentKey !== this.target()
    )
      return;
    const content = this.contentRef.current;
    if (!content) return;
    this.waiting = false;
    content.classList.remove("opacity-0");
    content.inert = false;
    content.removeAttribute("aria-hidden");
    this.entrance = content.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 80,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }

  componentWillUnmount() {
    this.clearAnimations();
  }

  private clearAnimations() {
    if (this.exit) this.exit.onfinish = null;
    this.exit?.cancel();
    this.entrance?.cancel();
    this.exit = undefined;
    this.entrance = undefined;
    this.outgoingRef.current?.replaceChildren();
  }

  render() {
    return (
      <div
        data-slot="content-transition"
        className={cn("relative min-h-0 min-w-0", this.props.className)}
      >
        <div
          ref={this.contentRef}
          data-slot="content-transition-live"
          className="h-full min-h-0 min-w-0"
        >
          {this.props.children}
        </div>
        <div
          ref={this.outgoingRef}
          data-slot="content-transition-outgoing"
          aria-hidden="true"
          inert
          className="pointer-events-none absolute inset-0 overflow-hidden bg-background empty:hidden"
        />
      </div>
    );
  }
}
