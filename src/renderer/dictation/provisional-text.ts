/** Ephemeral display metadata, not a second draft. Applies only to this exact field value. */
export interface ProvisionalTextSpan {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}
