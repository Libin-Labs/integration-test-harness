# @lp-labs/integration-test-harness

Run bounded integration scenarios against injected deterministic service doubles. Each call receives
a synthetic clock value and an isolated JSON input; results and expected failures are asserted in
order.

## Install and quick start

```sh
npm install @lp-labs/integration-test-harness
```

```js
import { createIntegrationHarness, createSequenceDouble } from '@lp-labs/integration-test-harness';

const lookup = createSequenceDouble([{ result: { status: 'ready' } }]);
const harness = createIntegrationHarness({ catalog: lookup.handler }, { now: 1_800_000_000_000 });
const result = await harness.run([
  {
    service: 'catalog',
    input: { sku: 'sku-4' },
    expect: { result: { status: 'ready' } },
  },
]);
if (result.assertions !== 1) throw new Error('Scenario did not run');
```

## API and types

- `createSequenceDouble(outcomes)` creates a FIFO fixture double returning JSON results or throwing
  `DoubleError` with the fixture's code and message. It accepts at most 10,000 fixtures; its
  `calls()` reports consumed fixtures.
- `createIntegrationHarness(services, options?)` injects service handlers and returns `run(steps,
signal?)`.
- `ScenarioStep` names the service, JSON input, optional non-negative `advanceBy`, and exactly one
  expected result or error code.
- `HarnessOptions` sets the deterministic starting epoch `now` (default 0), maximum calls (1,000),
  and maximum JSON nodes per value (10,000).
- `ServiceDouble` receives a detached input and `HarnessCallContext` (`now`, one-based `callIndex`,
  and optional `signal`); `HarnessFailure` describes expected fixture failures.
- `DoubleOutcome` is a fixture result-or-error union. `DoubleError` and
  `IntegrationHarnessError` are runtime error classes.
- `HarnessResult` includes the final synthetic time, assertion count, and ordered trace.
- Runtime errors: `IntegrationHarnessError` codes are `invalid-input`, `unknown-service`,
  `unexpected-call`, `assertion-failed`, `call-limit`, `aborted`, and `concurrent-run`.

The harness executes each scenario sequentially; one harness instance rejects overlapping `run`
calls. Abort signals are passed to service doubles and checked around each step, but doubles must
cooperate to cancel their own asynchronous work. The initial clock is fixed for each run and advances
only by scenario steps; it does not read or replace the process clock. Inputs, outputs, and fixtures
must be bounded finite JSON (depth at most 64); classes, cycles, accessors, symbols, and non-finite
numbers are rejected. Expectations compare JSON structurally: object key order is ignored and array
order is significant.

## Limits and scope

This package does not start servers, simulate network protocols, retry requests, or provide vendor
clients. Inject domain-specific fakes and assert the behavior relevant to your contract. Malformed or
unsupported JSON throws `IntegrationHarnessError` or `RangeError`; a mismatched fixture assertion
stops the scenario immediately. There are no runtime or peer dependencies; TypeScript and Prettier
are development-only.

ESM, CommonJS, and TypeScript declarations are included.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
