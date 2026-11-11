// Why something could not be shown: not allowed (never shown as empty), no connection, or failed.

import { ApiError } from "@ferrum/client";
import { StatePanel } from "@ferrum/kit";

export function Problem({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  if (error instanceof ApiError && error.status === 403) return <StatePanel kind="denied" title={title} />;
  if (error instanceof ApiError && error.status === 0) return <StatePanel kind="offline" title={title} onRetry={onRetry} />;
  return <StatePanel kind="failed" title={title} error={error} onRetry={onRetry} />;
}
