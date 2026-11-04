/** The sync log: a running list of what happened, newest first. */
export type LogKind = 'story' | 'edit' | 'sync' | 'stale' | 'loss' | 'network';

export interface LogEntry {
  id: number;
  /** Epoch milliseconds. */
  at: number;
  kind: LogKind;
  text: string;
}

export class Journal {
  readonly entries: LogEntry[] = [];
  private count = 0;

  constructor(
    private readonly now: () => number,
    private readonly limit = 300,
  ) {}

  add(kind: LogKind, text: string): void {
    this.entries.unshift({ id: ++this.count, at: this.now(), kind, text });
    if (this.entries.length > this.limit) this.entries.pop();
  }
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
