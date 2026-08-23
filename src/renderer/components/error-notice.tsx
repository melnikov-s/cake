import { CopyErrorDetailsButton } from "./copy-error-details-button";

export function ErrorNotice({
  title,
  message,
  details = message,
}: {
  title: string;
  message: string;
  details?: string;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
      {details && details !== message && (
        <details className="notice-error-details">
          <summary>Technical details</summary>
          <pre>{details}</pre>
        </details>
      )}
      <CopyErrorDetailsButton details={details} />
    </div>
  );
}
