import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * Keeps a page that throws from blanking the whole app. The shell stays up,
 * the error is shown, and moving to another page (a new resetKey) clears it.
 */
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ui] page crashed', error);
  }

  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-xl space-y-3 px-6 py-16">
        <h1 className="text-lg font-semibold">This page failed to load</h1>
        <p className="text-sm text-[var(--fg-muted)]">
          Something went wrong while showing this page. Reloading usually fixes it; if it keeps happening, send the
          message below to whoever runs InfraTicket.
        </p>
        <pre className="overflow-x-auto rounded-sm border bg-[var(--surface-2)] p-3 text-xs">{error.message}</pre>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}
