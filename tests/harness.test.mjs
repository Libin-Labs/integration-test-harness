import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  DoubleError,
  IntegrationHarnessError,
  createIntegrationHarness,
  createSequenceDouble,
} from '../dist/esm/index.js';

test('runs deterministic fixtures in order with a synthetic clock', async () => {
  const sequence = createSequenceDouble([
    { result: { status: 'queued' } },
    { error: { code: 'offline', message: 'service unavailable' } },
  ]);
  const observed = [];
  const harness = createIntegrationHarness(
    {
      catalog: async (input, context) => {
        observed.push({ input, now: context.now, callIndex: context.callIndex });
        return sequence.handler(input, context);
      },
    },
    { now: 100, maxCalls: 2 },
  );
  const result = await harness.run([
    { service: 'catalog', input: { sku: 'a' }, expect: { result: { status: 'queued' } } },
    {
      service: 'catalog',
      input: { sku: 'b' },
      advanceBy: 5,
      expect: { errorCode: 'offline' },
    },
  ]);
  assert.equal(result.now, 105);
  assert.equal(result.assertions, 2);
  assert.deepEqual(
    observed.map((entry) => [entry.now, entry.callIndex]),
    [
      [100, 1],
      [105, 2],
    ],
  );
  assert.equal(result.steps[1].error.code, 'offline');
});

test('rejects unknown services, exhausted fixtures, and mismatched assertions', async () => {
  const empty = createSequenceDouble([]);
  const harness = createIntegrationHarness({ empty: empty.handler });
  await assert.rejects(
    harness.run([{ service: 'missing', input: null, expect: { result: null } }]),
    (error) => error.code === 'unknown-service',
  );
  await assert.rejects(
    harness.run([{ service: 'empty', input: null, expect: { errorCode: 'anything' } }]),
    (error) => error.code === 'assertion-failed',
  );
  assert.ok(empty.calls() === 1);
  assert.ok(new DoubleError('x', 'y') instanceof Error);
});

test('bounds steps and rejects malformed or unsafe JSON', async () => {
  const harness = createIntegrationHarness({ echo: (input) => input }, { maxCalls: 1 });
  await assert.rejects(
    harness.run([
      { service: 'echo', input: 1, expect: { result: 1 } },
      { service: 'echo', input: 2, expect: { result: 2 } },
    ]),
    (error) => error.code === 'call-limit',
  );
  await assert.rejects(
    harness.run([{ service: 'echo', input: Infinity, expect: { result: Infinity } }]),
    (error) => error.code === 'invalid-input',
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    harness.run([{ service: 'echo', input: cyclic, expect: { result: null } }]),
    (error) => error.code === 'invalid-input',
  );
  await assert.rejects(
    harness.run([{ service: 'echo', input: null, expect: { result: null, errorCode: 'x' } }]),
    (error) => error.code === 'invalid-input',
  );
  const invalidOutput = createIntegrationHarness({ bad: () => Infinity });
  await assert.rejects(
    invalidOutput.run([{ service: 'bad', input: null, expect: { errorCode: 'invalid-input' } }]),
    (error) => error.code === 'invalid-input',
  );
  assert.throws(() => createSequenceDouble([{ result: 1, error: { code: 'x', message: 'x' } }]));
  assert.ok(new IntegrationHarnessError('aborted', 'x') instanceof Error);
});

test('rejects concurrent runs and forwards cooperative cancellation', async () => {
  let release;
  let receivedSignal;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const harness = createIntegrationHarness({
    async wait(_input, context) {
      receivedSignal = context.signal;
      await pending;
      return 'done';
    },
  });
  const first = harness.run(
    [{ service: 'wait', input: null, expect: { result: 'done' } }],
    controller.signal,
  );
  await assert.rejects(harness.run([]), (error) => error.code === 'concurrent-run');
  controller.abort();
  release();
  await assert.rejects(first, (error) => error.code === 'aborted');
  assert.equal(receivedSignal, controller.signal);
});

test('CommonJS exposes the same runtime API', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.deepEqual(Object.keys(cjs).sort(), [
    'DoubleError',
    'IntegrationHarnessError',
    'createIntegrationHarness',
    'createSequenceDouble',
  ]);
});
