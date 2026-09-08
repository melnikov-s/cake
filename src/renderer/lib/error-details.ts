export interface ErrorDetails {
  message: string;
  details: string;
}

export function describeError(error: unknown, context?: string): ErrorDetails {
  if (error instanceof Error) {
    const details = error.stack ?? `${error.name}: ${error.message}`;
    return {
      message: error.message || error.name,
      details: context ? `${details}\n\nContext:\n${context}` : details,
    };
  }
  const message = String(error);
  return { message, details: context ? `${message}\n\nContext:\n${context}` : message };
}
