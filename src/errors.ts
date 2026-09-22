/**
 * Errors that are "meant to be seen by the user"
 *
 * Project rule: non-programmer users must never see a stack trace.
 * So whenever the cause is clearly known, throw a ProblemError with a
 * plain-English message + a suggested fix.
 */
export class ProblemError extends Error {
  /** Extra detail lines, one issue per line */
  readonly details: string[];
  /** Suggested fix */
  readonly hint?: string;
  /** The file that caused this error (if any) */
  readonly file?: string;

  constructor(message: string, options: { details?: string[]; hint?: string; file?: string } = {}) {
    super(message);
    this.name = 'ProblemError';
    this.details = options.details ?? [];
    this.hint = options.hint;
    this.file = options.file;
  }

  /** Full text version for printing to the terminal */
  toPlainText(): string {
    const lines: string[] = [`❌ ${this.message}`];
    if (this.file) lines.push(`   File: ${this.file}`);
    for (const d of this.details) lines.push(`   • ${d}`);
    if (this.hint) lines.push(`   💡 ${this.hint}`);
    return lines.join('\n');
  }
}

/** Print an error to the terminal politely, then exit with code 1 */
export function reportAndExit(err: unknown): never {
  if (err instanceof ProblemError) {
    console.error(`\n${err.toPlainText()}\n`);
  } else if (err instanceof Error) {
    console.error(`\n❌ Unexpected error: ${err.message}`);
    console.error('   💡 If you cannot fix this yourself, send the message below to your administrator\n');
    console.error(err.stack ?? String(err));
    console.error('');
  } else {
    console.error(`\n❌ Unexpected error: ${String(err)}\n`);
  }
  process.exit(1);
}
