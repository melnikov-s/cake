import { Component, type ErrorInfo, type ReactNode } from "react";
import { Callout } from "./ui/callout";

interface ExtensionCompanionErrorBoundaryProps {
  readonly name: string;
  readonly children: ReactNode;
}

interface ExtensionCompanionErrorBoundaryState {
  readonly error?: Error;
}

export class ExtensionCompanionErrorBoundary extends Component<
  ExtensionCompanionErrorBoundaryProps,
  ExtensionCompanionErrorBoundaryState
> {
  state: ExtensionCompanionErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ExtensionCompanionErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[cake] Extension companion ${this.props.name} crashed`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Callout variant="error" className="mx-1 mb-2 p-2.5" role="alert">
        <strong className="text-xs">{this.props.name} could not render</strong>
        <span className="text-[11px] text-muted-foreground">{this.state.error.message}</span>
      </Callout>
    );
  }
}
