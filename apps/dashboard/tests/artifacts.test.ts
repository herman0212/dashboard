import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { artifactRegistry } from '../src/server/readers/artifact-reader.js';
import { identifier, safePath, safeRead, sanitizeText } from '../src/server/security.js';
import { fixture } from './helpers.js';

test('artifact registry never includes auth state, cookies, keys, prompts or arbitrary files', () => {
  const registry = artifactRegistry('.astra/deliverables');
  for (const slot of registry)
    assert.doesNotMatch(slot.slot, /auth-state|cookie|config\.toml|models\.json|prompts|\.env/i);
  assert.equal(
    registry.some((v) => v.slot.includes('src/')),
    false,
  );
});
test('path traversal, absolute paths and alternate data streams are blocked', () => {
  const f = fixture();
  try {
    for (const value of ['..', '../auth-state', 'x/y', 'x\\y', 'C:\\private', 'a..b', 'CON', 'NUL.json'])
      assert.throws(() => identifier(value));
    for (const value of ['../secret', '/private', 'C:\\private', 'x/../../private', '.astra/session.json:secret'])
      assert.throws(() => safePath(f.workspace, value));
    const file = safeRead(f.workspace, '.astra/session.json');
    assert.ok(file.length > 0);
  } finally {
    f.close();
  }
});
test('symlink/junction artifacts cannot be followed', (t) => {
  const f = fixture();
  try {
    const secret = path.join(f.root, 'outside-secret.txt');
    fs.writeFileSync(secret, 'must-never-read');
    try {
      fs.symlinkSync(secret, path.join(f.workspace, 'link.txt'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows sandbox cannot create symlinks; traversal/containment tests still run.');
        return;
      }
      throw error;
    }
    assert.throws(() => safeRead(f.workspace, 'link.txt'), /links are blocked/);
  } finally {
    f.close();
  }
});
test('redaction strips credential headers, JWTs, key patterns and URL credentials/query', () => {
  const value = sanitizeText(
    'Authorization: Bearer password-value\nCookie: sid=cookie-value\nAPI_KEY=key-value\nhttps://alice:password@example.test/path?api_key=secret-value#cookie\neyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTAwMH0.signature',
  );
  for (const secret of ['password-value', 'cookie-value', 'key-value', 'alice', 'secret-value', 'eyJhbGci'])
    assert.equal(value?.includes(secret), false);
});

test('redaction suppresses quoted JSON cookie and private prompt payloads inside allowed prose', () => {
  for (const value of [
    '{"cookies": [{"value":"secret-cookie"}]}',
    '{"prompt": "secret-prompt", "tail": "secret-tail"}',
    'raw_prompt: secret-prompt',
  ]) {
    const sanitized = sanitizeText(value);
    assert.equal(sanitized?.includes('secret-'), false);
  }
});

test('link rejection runs even on platforms that cannot create a symlink', (t) => {
  const f = fixture();
  try {
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (target: fs.PathLike) => {
      const stat = original(target);
      if (String(target).endsWith('session.json'))
        return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
      return stat;
    });
    assert.throws(() => safeRead(f.workspace, '.astra/session.json'), /links are blocked/);
    t.mock.restoreAll();
  } finally {
    f.close();
  }
});
