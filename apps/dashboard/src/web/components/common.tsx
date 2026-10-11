import type { DataReference, Fact } from '../../contracts.js';
export function Badge({ value }: { value: unknown }) {
  const text = value == null ? 'unknown' : String(value);
  return <span className={`badge status-${text.toLowerCase().replaceAll('_', '-')}`}>{text}</span>;
}
export function Value({ fact }: { fact: Fact<unknown> }) {
  return (
    <span title={fact.reasonCode ?? ''}>
      {fact.value == null ? <Badge value="unknown" /> : String(fact.value)}
      {fact.health === 'stale' ? <Badge value="stale" /> : null}
    </span>
  );
}
export function Duration({ ms }: { ms: number | null | undefined }) {
  if (ms == null) return <span className="muted">Unknown</span>;
  const seconds = Math.floor(ms / 1000);
  return (
    <span>
      {Math.floor(seconds / 3600)}h {Math.floor(seconds / 60) % 60}m {seconds % 60}s
    </span>
  );
}
export function Reference({ refs }: { refs: DataReference[] }) {
  return (
    <details className="provenance">
      <summary>Provenance</summary>
      {refs.map((ref) => (
        <dl key={JSON.stringify(ref)}>
          <dt>Source / scope</dt>
          <dd>
            {ref.source} / {ref.scope}
          </dd>
          <dt>Checkpoint</dt>
          <dd>{ref.checkpoint ?? 'Unknown'}</dd>
          <dt>SHA-256</dt>
          <dd>{ref.sha256 ?? 'Unknown'}</dd>
          <dt>Record</dt>
          <dd>{ref.jsonPointer ?? 'Unknown'}</dd>
        </dl>
      ))}
    </details>
  );
}
export function ReadState({ loading, error, stale }: { loading: boolean; error: string | null; stale: boolean }) {
  return (
    <>
      {loading ? (
        <p className="muted" role="status">
          Reading data sources…
        </p>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
          {stale ? ' Showing the last observation (stale).' : ''}
        </p>
      ) : null}
    </>
  );
}
