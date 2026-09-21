const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotifyRequest, heartbeatStale, createNotifier } = require('../dist/notify');

test('no webhook means no request at all', () => {
  assert.equal(buildNotifyRequest(undefined, { kind: 'job-finished', title: 'x' }), null);
  assert.equal(buildNotifyRequest('   ', { kind: 'job-finished', title: 'x' }), null);
  assert.equal(buildNotifyRequest('not a url', { kind: 'job-finished', title: 'x' }), null);
});

test('a generic webhook gets the structured event, Telegram gets chat_id + text', () => {
  const generic = buildNotifyRequest('https://example.com/hook', { kind: 'job-finished', title: 'SUCCESS — X', detail: 'minted 1/1' }, undefined);
  assert.equal(generic.url, 'https://example.com/hook');
  assert.equal(generic.body.kind, 'job-finished');
  assert.ok(generic.body.at);

  const telegram = buildNotifyRequest('https://api.telegram.org/bot123/sendMessage', { kind: 'job-finished', title: 'SUCCESS' }, '42');
  assert.equal(telegram.body.chat_id, '42');
  assert.match(telegram.body.text, /SUCCESS/);
  // A Telegram URL without a chat id would be a guaranteed 400: skip it.
  assert.equal(buildNotifyRequest('https://api.telegram.org/bot123/sendMessage', { kind: 'job-finished', title: 'x' }), null);
});

test('a stalled executor is only stale after the threshold', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  assert.equal(heartbeatStale({ at: new Date(now - 60_000).toISOString() }, now), false);
  assert.equal(heartbeatStale({ at: new Date(now - 6 * 60_000).toISOString() }, now), true);
  assert.equal(heartbeatStale(null, now), false, 'never seen is not stale');
  assert.equal(heartbeatStale({}, now), false);
});

test('delivery failures are swallowed', async () => {
  let called = 0;
  const notifier = createNotifier('https://example.com/hook', undefined, async () => {
    called++;
    throw new Error('network down');
  });
  assert.doesNotThrow(() => notifier.send({ kind: 'executor-stale', title: 'x' }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, 1);
});
