import type { LogEntry, LogKind } from '../journal';

const ICON: Record<LogKind, string> = { story: '▶', edit: '✎', sync: '⇄', stale: '⚠', loss: '⚠', network: '⚡' };

export function SyncLog({ entries, emptyText = 'Nothing yet. Take an order, or press “Play lunch rush”.' }: { entries: LogEntry[]; emptyText?: string }) {
  return (
    <section className="log card" aria-label="Sync log">
      <header className="log-head">
        <h2>Sync log</h2>
        <span className="hint">Newest first. ⚠ marks a write that lost, or data that vanished.</span>
      </header>
      {entries.length === 0 ? (
        <p className="empty">{emptyText}</p>
      ) : (
        <ol>
          {entries.slice(0, 80).map((e) => (
            <li key={e.id} className={`log-${e.kind}`}>
              <time>{clock(e.at)}</time>
              <span className="log-icon" aria-hidden="true">
                {ICON[e.kind]}
              </span>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
