import type { ReactNode } from "react";
import { ErrorNotice } from "./error-notice";

export interface ChatTranscriptFooterContext {
  footer?: ReactNode;
  error?: { message?: string; details?: string; title?: string };
}

/** Stable Virtuoso component identity keeps streaming updates from remounting the dock spacer. */
export function ChatTranscriptFooter({ context }: { context?: ChatTranscriptFooterContext }) {
  return (
    <div className="mx-auto w-full max-w-[51rem] px-6 pb-[var(--composer-dock-height,210px)] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pb-2 in-[.chat-layout-compact]:min-h-0">
      {context?.footer}
      {context?.error?.message && (
        <ErrorNotice
          title={context.error.title ?? "Operation failed"}
          message={context.error.message}
          details={context.error.details}
        />
      )}
    </div>
  );
}
