export interface CakeChatLocation {
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

export interface CakeChatLocationOptions {
  readonly homeDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

export const make = (options: CakeChatLocationOptions): CakeChatLocation => ({
  workingDirectory: options.homeDirectory,
  sessionDirectory: options.sessionDirectory,
  resolvedSessionDirectory: options.resolvedSessionDirectory,
});
