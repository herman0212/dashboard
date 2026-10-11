import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseLogLine, readLogs } from '../src/server/readers/log-reader.js';
import { reference } from '../src/server/readers/report-reader.js';
import { readWorkspace } from '../src/server/readers/workspace-reader.js';
import { fixture } from './helpers.js';

test('tool arguments and unknown lines cannot be published', () => {
  const line = '[2026-01-01 00:00:00] [recon] bash: {"command":"API_KEY=very-secret curl","cookies":"session-secret"}';
  const log = parseLogLine(line, '1', 'workflow-log', reference('logs'));
  assert.equal(log?.message, 'Tool invoked: bash. Arguments withheld.');
  assert.equal(log?.sanitizedRaw, null);
  assert.equal(JSON.stringify(log).includes('very-secret'), false);
  assert.equal(
    parseLogLine('[2026-01-01 00:00:00] [recon] random secret=password', '2', 'workflow-log', reference('logs')),
    null,
  );
});
test('pagination is incremental, signed, scoped and invalidated after truncation', () => {
  const f = fixture();
  try {
    const logPath = path.join(f.workspace, '.astra/workflow.log');
    fs.writeFileSync(logPath, '[2026-01-01 00:00:00] [recon] read: {"path":"private"}\n');
    const ws = readWorkspace(f.root, f.name);
    const first = readLogs(ws, new URLSearchParams());
    fs.appendFileSync(logPath, '[2026-01-01 00:00:01] [recon] grep: {"pattern":"private"}\n');
    const next = readLogs(ws, new URLSearchParams({ cursor: first.nextCursor, direction: 'forward' }));
    assert.equal(next.entries.length, 1);
    assert.match(next.entries[0]?.message ?? '', /grep/);
    assert.equal(next.entries[0]?.source, 'workflow-log');
    fs.writeFileSync(logPath, '');
    assert.throws(
      () => readLogs(ws, new URLSearchParams({ cursor: next.nextCursor, direction: 'forward' })),
      /truncated/,
    );
    assert.throws(() => readLogs(ws, new URLSearchParams({ agent: '../../auth-state' })), /Unknown agent/);
  } finally {
    f.close();
  }
});
