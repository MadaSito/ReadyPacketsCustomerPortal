import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Callout } from "@/ui";

interface State {
  error: Error | null;
}

/** Catches render errors (incl. failed lazy chunk loads). Never shows stack traces or raw messages. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Diagnostics are server-side; the client never logs to console in production. */
  }
  override render() {
    if (!this.state.error) return this.props.children;
    const chunk = /dynamically imported module|Loading chunk|Failed to fetch/i.test(this.state.error.message);
    return (
      <div className="mx-auto max-w-xl py-10">
        <Callout
          tone="danger"
          live="assertive"
          title={chunk ? "A new version of the portal is available" : "This page could not be displayed"}
          actions={<Button onClick={() => window.location.reload()}>{chunk ? "Reload" : "Reload page"}</Button>}
        >
          {chunk ? "Reload to continue with the latest version." : "Something went wrong while showing this page. Reloading usually fixes it. If it keeps happening, contact support."}
        </Callout>
      </div>
    );
  }
}
