import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";
import { CopyErrorDetailsButton } from "./copy-error-details-button";

interface RendererErrorBoundaryProps {
  children: ReactNode;
  onReload?: () => void;
}

interface RendererErrorBoundaryState {
  error?: Error;
  componentStack?: string;
}

function reloadRenderer() {
  window.location.reload();
}

function errorDetails(error: Error, componentStack?: string) {
  const stack = error.stack ?? `${error.name}: ${error.message}`;
  const reactStack = componentStack?.trim();
  return reactStack ? `${stack}\n\nReact component stack:\n${reactStack}` : stack;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const details = errorDetails(error, info.componentStack ?? undefined);
    console.error("[cake] Renderer crashed:", details);
    this.setState({ componentStack: info.componentStack ?? undefined });
    if (typeof __CAKE_CUSTOMIZATION_REVISION__ !== "undefined" && __CAKE_CUSTOMIZATION_REVISION__) {
      void window.cake?.request({
        type: "customization-runtime-failed",
        revision: __CAKE_CUSTOMIZATION_REVISION__,
        message: details,
      });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = errorDetails(error, this.state.componentStack);

    return (
      <main
        className="grid min-h-screen w-full place-items-center overflow-auto bg-background p-8"
        role="alert"
      >
        <section className="w-[min(680px,100%)] rounded-2xl border border-border bg-card p-8 shadow-2xl">
          <div
            className="mb-5 grid size-10 place-items-center rounded-xl bg-destructive/15 font-mono text-xl font-bold text-destructive"
            aria-hidden="true"
          >
            !
          </div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Cake encountered an error
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            The renderer crashed
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Your project and session data are safe. Reload Cake to restart the interface.
          </p>
          <div className="my-5">
            <Button autoFocus onClick={this.props.onReload ?? reloadRenderer}>
              Reload Cake
            </Button>
          </div>
          <details open className="border-t border-border pt-4 text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
              Error details
            </summary>
            <pre className="my-3 max-h-56 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {details}
            </pre>
            <CopyErrorDetailsButton details={details} />
          </details>
        </section>
      </main>
    );
  }
}
