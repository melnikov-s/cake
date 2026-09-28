import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

interface DrawCanvasErrorBoundaryProps {
  readonly children: ReactNode;
  onRetry(): void;
}

interface DrawCanvasErrorBoundaryState {
  readonly error?: Error;
}

/** Contains Cake Draw editor failures to the canvas so the rest of Cake remains usable. */
export class DrawCanvasErrorBoundary extends Component<
  DrawCanvasErrorBoundaryProps,
  DrawCanvasErrorBoundaryState
> {
  state: DrawCanvasErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): DrawCanvasErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[cake] Cake Draw editor failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <Callout variant="error" className="max-w-md" role="alert">
          <strong className="text-sm">Cake Draw could not load</strong>
          <span className="text-muted-foreground">{this.state.error.message}</span>
          <div>
            <Button size="sm" variant="outline" onClick={this.props.onRetry}>
              Retry
            </Button>
          </div>
        </Callout>
      </div>
    );
  }
}
