import {
  createIntegrationHarness,
  createSequenceDouble,
  type ScenarioStep,
} from '@lp-labs/integration-test-harness';

const fixture = createSequenceDouble([{ result: { ok: true } }]);
const scenario: ScenarioStep[] = [
  {
    service: 'sample',
    input: null,
    expect: { result: { ok: true } },
  },
];
void createIntegrationHarness({ sample: fixture.handler }).run(scenario);
