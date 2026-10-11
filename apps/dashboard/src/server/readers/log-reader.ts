import fs from 'node:fs';
import { CAPELLA_PROGRESS_STAGES, isLoggableAgentName } from '@astra/worker/dashboard-read';
import { PIPELINE } from '@keygraph/astra/dashboard-read';
import type { LogEntry, LogLevel, LogsResponse } from '../../contracts.js';
import { decodeCursor, encodeCursor, pageLimit } from '../cursor.js';
import { digest, HttpError, iso, missing, safePath } from '../security.js';
import { reference } from './report-reader.js';
import type { WorkspaceRead } from './workspace-reader.js';

const phases = new Set([
  ...PIPELINE.map((v) => v.key),
  'setup',
  'preflight',
  'auth-validation',
  'vulnerability-exploitation',
]);
const tools = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'glob',
  'task',
  'todowrite',
  'todo_write',
  'add_finding',
  'add_exploit',
  'submit_exploitation_queue',
  'submit_findings',
  'submit_architecture',
  'submit_review',
  'submit_confirmation',
  'submit_calibration',
]);
/** Closed-format parsing publishes fixed sentences. Raw/unknown lines are suppressed entirely. */
export function parseLogLine(
  line: string,
  id: string,
  source: LogEntry['source'],
  ref: LogEntry['reference'],
): LogEntry | null {
  const timestamped = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^\]]+)\] (.*)$/);
  if (!timestamped) {
    const terminal = line.match(/^Scan (COMPLETED|PARTIAL|FAILED|CANCELLED)$/);
    if (!terminal) return null;
    return {
      id,
      source,
      timestamp: null,
      agent: null,
      phase: null,
      attempt: null,
      event: 'scan-terminal',
      parseStatus: 'recognized',
      message: `Recorded scan outcome: ${terminal[1]}`,
      level: terminal[1] === 'FAILED' ? 'error' : 'info',
      sanitizedRaw: null,
      reference: ref,
    };
  }
  const [, stamp, actor, body] = timestamped;
  if (!body || !actor) return null;
  let agent: string | null = null;
  let phase: string | null = null;
  let attempt: number | null = null;
  let event: string | null = null;
  let message = '';
  let level: LogLevel = 'info';
  let redacted = false;
  if (actor === 'PHASE') {
    const match = body.match(/^(Starting|Completed): ([a-z-]+)$/);
    if (!match?.[2] || !phases.has(match[2])) return null;
    phase = match[2];
    event = 'phase';
    message = `${match[1]} phase: ${phase}`;
  } else if (actor === 'AGENT') {
    const match = body.match(
      /^([a-z-]+): (Starting|Started|Success|Completed|Failed|Cancelled|Skipped|Rolled back|Rollback)(?: \(([^)]*)\))?/i,
    );
    if (!match?.[1] || !isLoggableAgentName(match[1])) return null;
    agent = match[1];
    event = 'agent';
    message = `Agent ${match[2]?.toLowerCase()}.`;
    const n = body.match(/attempt (\d+)/);
    attempt = n ? Number(n[1]) : null;
    if (/Failed/i.test(match[2] ?? '')) level = 'error';
  } else if (actor === 'AGENTIC-SAST') {
    const match = body.match(/^([A-Za-z -]{1,50}): (Starting|Completed|Failed, retrying|Failed|Cancelled)/);
    if (!match) return null;
    event = 'sast-stage';
    message = `Static analysis stage: ${match[2]}.`;
    level = match[2] === 'Failed' ? 'error' : match[2] === 'Failed, retrying' ? 'warn' : 'info';
  } else {
    const owner = actor.split(' > ')[0];
    if (!owner || !(isLoggableAgentName(owner) || owner === 'agentic-sast')) return null;
    agent = owner === 'agentic-sast' ? null : owner;
    if (owner === 'agentic-sast') {
      const stage = actor.split(' > ')[1];
      if (!stage || !CAPELLA_PROGRESS_STAGES.includes(stage as (typeof CAPELLA_PROGRESS_STAGES)[number])) return null;
      phase = `agentic-sast:${stage}`;
    }
    const tool = body.match(/^([a-z_]+):/);
    if (tool?.[1] && tools.has(tool[1])) {
      event = tool[1] === 'task' && /^task: started subagent /.test(body) ? 'delegation' : 'tool';
      message = event === 'delegation' ? 'Delegated task started.' : `Tool invoked: ${tool[1]}. Arguments withheld.`;
      redacted = true;
      const count = body.match(/^[a-z_]+: submitted (\d{1,8}) findings$/);
      if (count) {
        message = `Submitted ${count[1]} findings.`;
        redacted = false;
      }
    } else if (/^(?:[a-z_]+ )?(?:failed|slow) \([0-9.ms h]+\)$/.test(body)) {
      event = 'tool';
      message = /failed/.test(body) ? 'Tool attempt failed.' : 'Tool completed slowly.';
      level = 'warn';
    } else if (/^completed \([0-9ms h.,]+(?:\d+ turns, \d+ operations)\)$/.test(body)) {
      event = 'lifecycle';
      message = 'Delegated/static session completed.';
    } else if (/^(failed|cancelled) \([0-9ms h.]+, (CHILD_TASK_FAILED|CANCELLED)\)$/.test(body)) {
      event = 'lifecycle';
      message = 'Delegated session failed or cancelled.';
      level = 'error';
    } else if (
      /^\[ERROR\] [A-Z_]+ \((?:config|network|prompt|filesystem|validation|unknown), attempt \d+, [0-9ms h.]+, \d+ turns\)$/.test(
        body,
      )
    ) {
      event = 'attempt-error';
      message = 'An activity attempt recorded an error. This does not prove terminal failure.';
      level = 'warn';
      attempt = Number(body.match(/attempt (\d+)/)?.[1] ?? 0);
    } else return null;
  }
  if (agent && !phase) phase = PIPELINE.find((p) => p.agents.some((a) => a.name === agent))?.key ?? null;
  return {
    id,
    timestamp: iso(`${stamp?.replace(' ', 'T')}Z`),
    source,
    agent,
    phase,
    attempt,
    event,
    parseStatus: redacted ? 'redacted' : 'recognized',
    message,
    level,
    sanitizedRaw: null,
    reference: ref,
  };
}
export function readLogs(ws: WorkspaceRead, query: URLSearchParams): LogsResponse {
  const agent = query.get('agent');
  const allowedAgents = [
    ...PIPELINE.flatMap((v) => v.agents.map((a) => a.name)),
    ...CAPELLA_PROGRESS_STAGES.map((v) => `agentic-sast-${v}`),
  ];
  if (agent && !allowedAgents.includes(agent)) throw new HttpError(400, 'InvalidAgent', 'Unknown agent log.');
  const limit = pageLimit(query.get('limit'), 200, 1000);
  const q = (query.get('q') ?? '').toLowerCase();
  if (q.length > 200) throw new HttpError(400, 'QueryLimit', 'Search is too long.');
  const level = query.get('level');
  if (level && !['debug', 'info', 'warn', 'error', 'unknown'].includes(level))
    throw new HttpError(400, 'InvalidLevel', 'Unknown log level.');
  const direction = query.get('direction') ?? (query.has('cursor') ? 'forward' : 'backward');
  if (!['forward', 'backward'].includes(direction))
    throw new HttpError(400, 'InvalidDirection', 'Unknown log direction.');
  const scope = `${ws.name}|${ws.identityRevision}|${agent}|${query.get('phase')}|${level}|${q}`;
  const cursor = decodeCursor(query.get('cursor'), 'logs', scope);
  let slot = agent ? `.astra/agents/${agent}.log` : '.astra/workflow.log';
  let target: string;
  try {
    target = safePath(ws.root, slot);
  } catch (error) {
    if (missing(error) && !agent) {
      slot = 'workflow.log';
      try {
        target = safePath(ws.root, slot);
      } catch {
        throw new HttpError(503, 'LogsUnavailable', 'No readable execution log is available.');
      }
    } else if (missing(error)) throw new HttpError(503, 'LogsUnavailable', 'No readable agent log is available.');
    else throw error;
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink > 1) throw new HttpError(403, 'UnsafeLog', 'Log file is blocked.');
  const generation = digest(`${slot}|${stat.dev}|${stat.ino}|${stat.birthtimeMs}`);
  if (cursor && (cursor.revision !== generation || cursor.offset > stat.size))
    throw new HttpError(409, 'CursorInvalidated', 'Log rotated or truncated. Refresh the log.', true);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const read = (start: number, end: number): Buffer => {
    const bytes = Buffer.alloc(Math.max(0, end - start));
    const n = fs.readSync(fd, bytes, 0, bytes.length, start);
    return bytes.subarray(0, n);
  };
  try {
    const opened = fs.fstatSync(fd);
    safePath(ws.root, slot);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new HttpError(409, 'CursorInvalidated', 'Log changed while opening.', true);
    if (cursor?.anchor && digest(read(Math.max(0, cursor.offset - 128), cursor.offset)) !== cursor.anchor)
      throw new HttpError(409, 'CursorInvalidated', 'Log content changed. Refresh the log.', true);
    const budget = 256 * 1024;
    const end =
      direction === 'backward'
        ? (cursor?.offset ?? opened.size)
        : Math.min(opened.size, (cursor?.offset ?? 0) + budget);
    const start = direction === 'backward' ? Math.max(0, end - budget) : (cursor?.offset ?? 0);
    const chunk = read(start, end);
    let pos = 0;
    if (start > 0 && direction === 'backward') {
      const newline = chunk.indexOf(10);
      pos = newline < 0 ? chunk.length : newline + 1;
    }
    const entries: { entry: LogEntry; start: number; end: number }[] = [];
    let omittedCount = 0;
    let consumed = start + pos;
    while (pos < chunk.length) {
      const next = chunk.indexOf(10, pos);
      if (next < 0) break; // wait for an append to finish this line
      const begin = start + pos;
      const finish = start + next + 1;
      const line = chunk.subarray(pos, next).toString('utf8').replace(/\r$/, '');
      const entry =
        line.length <= 16000
          ? parseLogLine(
              line,
              digest(generation + begin),
              agent ? 'agent-log' : 'workflow-log',
              reference('logs', {
                scope: 'workspace',
                artifactId: digest(slot + generation),
                jsonPointer: `bytes:${begin}-${finish}`,
              }),
            )
          : null;
      consumed = finish;
      pos = next + 1;
      if (
        entry &&
        (!level || entry.level === level) &&
        (!query.get('phase') || entry.phase === query.get('phase')) &&
        (!q || entry.message.toLowerCase().includes(q))
      )
        entries.push({ entry, start: begin, end: finish });
      else omittedCount++;
      if (direction === 'forward' && entries.length >= limit) break;
    }
    if (pos === 0 && chunk.length === budget) {
      consumed = end;
      omittedCount++;
    }
    const chosen = direction === 'backward' ? entries.slice(-limit) : entries;
    const olderOffset = chosen[0]?.start ?? start;
    const nextCursor = encodeCursor({
      kind: 'logs',
      scope,
      revision: generation,
      offset: consumed,
      anchor: digest(read(Math.max(0, consumed - 128), consumed)),
    });
    const olderCursor =
      olderOffset > 0
        ? encodeCursor({
            kind: 'logs',
            scope,
            revision: generation,
            offset: olderOffset,
            anchor: digest(read(Math.max(0, olderOffset - 128), olderOffset)),
          })
        : null;
    safePath(ws.root, slot);
    return {
      entries: chosen.map((v) => v.entry),
      nextCursor,
      olderCursor,
      hasMore: consumed < opened.size,
      omittedCount,
      scope: 'workspace',
    };
  } finally {
    fs.closeSync(fd);
  }
}
