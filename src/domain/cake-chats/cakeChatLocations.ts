export interface CakeChatLocation {
  readonly workingDirectory: string;
  /** Directory holding the permanent coordinator's Pi Durable SQLite database. */
  readonly sessionDirectory: string;
}

export interface CakeChatLocationOptions {
  readonly homeDirectory: string;
  readonly sessionDirectory: string;
}

export const make = (options: CakeChatLocationOptions): CakeChatLocation => ({
  workingDirectory: options.homeDirectory,
  sessionDirectory: options.sessionDirectory,
});
