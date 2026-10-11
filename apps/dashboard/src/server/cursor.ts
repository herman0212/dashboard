import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, record } from './security.js';

const key = randomBytes(32);
export interface Cursor {
  kind: string;
  scope: string;
  revision: string;
  offset: number;
  anchor?: string;
}
export function encodeCursor(value: Cursor): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
export function decodeCursor(input: string | null, kind: string, scope: string): Cursor | null {
  if (!input) return null;
  if (input.length > 2048) throw new HttpError(400, 'InvalidCursor', 'Invalid cursor.');
  const [body, signature] = input.split('.');
  if (!body || !signature) throw new HttpError(400, 'InvalidCursor', 'Invalid cursor.');
  const expected = createHmac('sha256', key).update(body).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new HttpError(400, 'InvalidCursor', 'Invalid cursor.');
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(Buffer.from(body, 'base64url').toString()));
  } catch {
    throw new HttpError(400, 'InvalidCursor', 'Invalid cursor.');
  }
  if (
    value.kind !== kind ||
    value.scope !== scope ||
    typeof value.revision !== 'string' ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0
  )
    throw new HttpError(400, 'InvalidCursor', 'Cursor does not match the request.');
  return value as unknown as Cursor;
}
export function pageLimit(input: string | null, fallback: number, max: number): number {
  if (input === null) return fallback;
  const value = Number(input);
  if (!/^\d+$/.test(input) || !Number.isInteger(value) || value < 1 || value > max)
    throw new HttpError(400, 'InvalidLimit', `Limit must be between 1 and ${max}.`);
  return value;
}
