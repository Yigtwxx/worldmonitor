// Regression test for issue #5870: seed-cross-source-signals read its 20+ input
// keys with a bare JSON.parse and no envelope unwrap.
//
// Most of those keys are written by contract-mode seeders, which store
// `{ _seed, data }` (scripts/_seed-utils.mjs:499). So `d['<key>']` was the
// envelope, every extractor's `payload.<field>` was undefined, and the signal
// silently never fired — the seeder still exited 0 and published, just with
// fewer signals than it should. Same failure shape as the one
// tests/regional-snapshot-envelope-unwrap.test.mjs pins one layer down.
//
// The existing suites could not catch this: their vm harness deleted
// readAllSourceKeys and fed extractors hand-built bare fixtures, i.e. the
// pre-envelope world, at exactly the seam where the defect lives.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_KEYS, readAllSourceKeys } from '../scripts/seed-cross-source-signals.mjs';
import { unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';

const REDIS_URL = 'https://cross-source-signals.test.upstash.io';

function seedEnvelope(data) {
  return {
    _seed: {
      fetchedAt: Date.now(),
      sourceVersion: 'test-v1',
      schemaVersion: 1,
      recordCount: 1,
    },
    data,
  };
}

// Drive a value through exactly what readAllSourceKeys does to a Redis string,
// so a fixture can never accidentally test a shape the reader does not produce.
function asReadByTheSeeder(redisValue) {
  return unwrapEnvelope(JSON.parse(JSON.stringify(redisValue))).data;
}

describe('readAllSourceKeys envelope handling', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  // Stub the Upstash pipeline: `byKey` maps a source key to the raw string
  // Redis would return; anything unlisted comes back as a null result.
  function stubPipeline(byKey) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => SOURCE_KEYS.map((key) => ({ result: byKey[key] ?? null })),
    });
  }

  it('unwraps a contract-mode envelope down to its payload', async () => {
    const payload = { earthquakes: [{ id: 'us1', magnitude: 7.1 }] };
    stubPipeline({ 'seismology:earthquakes:v1': JSON.stringify(seedEnvelope(payload)) });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['seismology:earthquakes:v1'], payload);
  });

  it('passes a legacy bare payload through unchanged', async () => {
    const payload = { flights: [{ id: 'opensky-1' }], fetchedAt: 1_700_000_000_000 };
    stubPipeline({ 'military:flights:v1': JSON.stringify(payload) });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['military:flights:v1'], payload);
  });

  // gdelt:intel:tone:* is the one live payload shaped like half an envelope: a
  // top-level `data` array plus a `fetchedAt`, but no `_seed`. unwrapEnvelope
  // only unwraps when `_seed.fetchedAt` is a number, so it must pass through —
  // unwrapping it would hand the tone extractor a bare array and kill the one
  // signal path that works today.
  it('does not unwrap a legacy payload that has its own top-level data field', async () => {
    const tone = {
      data: [{ date: '2026-07-20', value: -2.4 }],
      fetchedAt: new Date().toISOString(),
    };
    stubPipeline({ 'gdelt:intel:tone:military': JSON.stringify(tone) });

    const data = await readAllSourceKeys();
    assert.deepEqual(data['gdelt:intel:tone:military'], tone);
  });

  it('skips malformed JSON instead of registering the raw string as a found key', async () => {
    stubPipeline({ 'unrest:events:v1': '{"events":[' });

    const data = await readAllSourceKeys();
    assert.equal('unrest:events:v1' in data, false);
  });

  it('skips an envelope whose payload is null', async () => {
    stubPipeline({ 'infra:outages:v1': JSON.stringify(seedEnvelope(null)) });

    const data = await readAllSourceKeys();
    assert.equal('infra:outages:v1' in data, false);
  });

  it('returns no keys when every pipeline slot is empty', async () => {
    stubPipeline({});

    const data = await readAllSourceKeys();
    assert.deepEqual(Object.keys(data), []);
  });
});

export { asReadByTheSeeder, seedEnvelope };
