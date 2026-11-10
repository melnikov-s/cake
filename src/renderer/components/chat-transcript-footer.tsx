import type { ReactNode } from "react";
import { ErrorNotice } from "./error-notice";

export interface ChatTranscriptFooterError {
  message?: string;
  details?: string;
  title?: string;
}

/** Content after the last row, plus room for the composer docked over the transcript. */
export function ChatTranscriptFooter({
  footer,
  error,
}: {
  footer?: ReactNode;
  error?: ChatTranscriptFooterError;
}) {
  return (
    <div
      data-slot="transcript-footer"
      className="mx-auto w-full max-w-[51rem] px-6 pb-[var(--composer-dock-height,210px)] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pb-2 in-[.chat-layout-compact]:min-h-0"
    >
      {footer}
      {error?.message && (
        <ErrorNotice
          title={error.title ?? "Operation failed"}
          message={error.message}
          details={error.details}
        />
      )}
    </div>
  );
}
