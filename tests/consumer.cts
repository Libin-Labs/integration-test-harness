import { createIntegrationHarness } from '@lp-labs/integration-test-harness';

const harness = createIntegrationHarness({ echo: (value) => value }, { now: 0 });
const result: Promise<{ now: number; assertions: number; steps: readonly unknown[] }> = harness.run(
  [{ service: 'echo', input: 'ok', expect: { result: 'ok' } }],
);
void result;
