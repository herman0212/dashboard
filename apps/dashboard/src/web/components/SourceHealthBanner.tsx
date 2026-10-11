import type { SourceHealth } from '../../contracts.js';
import { Badge } from './common.js';
export function SourceHealthBanner({ sources, stale }: { sources: SourceHealth[]; stale: boolean }) {
  return (
    <aside className="health">
      <strong>Data sources{stale ? ' — stale observation' : ''}</strong>
      <div>
        {sources.map((s) => (
          <span key={s.source} title={s.reasonCode ?? `Last successful read: ${s.lastSuccessAt}`}>
            {s.source} <Badge value={s.health} />
          </span>
        ))}
      </div>
    </aside>
  );
}
