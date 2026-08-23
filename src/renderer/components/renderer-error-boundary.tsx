import { Component, type ErrorInfo, type ReactNode } from "react";
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
      <main className="renderer-crash" role="alert">
        <section className="renderer-crash-card">
          <div className="renderer-crash-mark" aria-hidden="true">
            !
          </div>
          <p className="renderer-crash-eyebrow">Cake encountered an error</p>
          <h1>The renderer crashed</h1>
          <p>Your project and session data are safe. Reload Cake to restart the interface.</p>
          <button type="button" autoFocus onClick={this.props.onReload ?? reloadRenderer}>
            Reload Cake
          </button>
          <details open>
            <summary>Error details</summary>
            <pre>{details}</pre>
            <CopyErrorDetailsButton details={details} />
          </details>
        </section>
      </main>
    );
  }
}
