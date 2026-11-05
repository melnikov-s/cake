/** Text editing API shared by the native textarea and atomic inline-reference input. */
export interface ComposerInputElement extends HTMLElement {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  setSelectionRange(start: number, end: number): void;
}
