const SESSION_LABEL_NAME_MAX_LENGTH = 40;

export type SessionLabelNameValidation =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

/** Shared label-name normalization for domain mutations and renderer fast validation. */
export const validateSessionLabelName = (name: string): SessionLabelNameValidation => {
  const normalized = name.trim();
  if (!normalized) return { ok: false, message: "Label names cannot be empty" };
  if (normalized.length > SESSION_LABEL_NAME_MAX_LENGTH)
    return {
      ok: false,
      message: `Label names cannot exceed ${SESSION_LABEL_NAME_MAX_LENGTH} characters`,
    };
  return { ok: true, name: normalized };
};
