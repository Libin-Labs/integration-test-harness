export type HarnessJson =
  null | boolean | number | string | HarnessJson[] | { [key: string]: HarnessJson };

export interface HarnessFailure {
  readonly code: string;
  readonly message: string;
}

export type DoubleOutcome = { readonly result: HarnessJson } | { readonly error: HarnessFailure };

export interface HarnessCallContext {
  readonly now: number;
  readonly signal?: AbortSignal;
  readonly callIndex: number;
}

export type ServiceDouble = (
  input: HarnessJson,
  context: HarnessCallContext,
) => HarnessJson | Promise<HarnessJson>;

export interface ScenarioStep {
  readonly service: string;
  readonly input: HarnessJson;
  readonly advanceBy?: number;
  readonly expect: { readonly result: HarnessJson } | { readonly errorCode: string };
}

export interface HarnessOptions {
  readonly now?: number;
  readonly maxCalls?: number;
  readonly maxNodes?: number;
}

export interface HarnessResult {
  readonly now: number;
  readonly assertions: number;
  readonly steps: readonly {
    readonly service: string;
    readonly input: HarnessJson;
    readonly result?: HarnessJson;
    readonly error?: HarnessFailure;
    readonly now: number;
  }[];
}

export class IntegrationHarnessError extends Error {
  constructor(
    readonly code:
      | 'invalid-input'
      | 'unknown-service'
      | 'unexpected-call'
      | 'assertion-failed'
      | 'call-limit'
      | 'aborted'
      | 'concurrent-run',
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationHarnessError';
  }
}

export class DoubleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DoubleError';
  }
}

function copyJson<T>(input: T, maxNodes: number): T {
  let count = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): HarnessJson => {
    if (++count > maxNodes || depth > 64) {
      throw new IntegrationHarnessError(
        'invalid-input',
        'Scenario JSON exceeds configured bounds.',
      );
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      if (active.has(value)) {
        throw new IntegrationHarnessError('invalid-input', 'Scenario JSON cannot contain cycles.');
      }
      active.add(value);
      const result = Array.from(value, (entry) => visit(entry, depth + 1));
      active.delete(value);
      return result;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new IntegrationHarnessError(
        'invalid-input',
        'Scenario values must be finite JSON and plain objects.',
      );
    }
    if (active.has(value)) {
      throw new IntegrationHarnessError('invalid-input', 'Scenario JSON cannot contain cycles.');
    }
    active.add(value);
    const result: Record<string, HarnessJson> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor =
        typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new IntegrationHarnessError(
          'invalid-input',
          'Scenario objects must contain enumerable string data fields.',
        );
      }
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return result;
  };
  return visit(input, 0) as T;
}

function equalJson(left: HarnessJson, right: HarnessJson): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]!))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key]!, right[key]!))
  );
}

export function createSequenceDouble(outcomes: readonly DoubleOutcome[]): {
  readonly handler: ServiceDouble;
  readonly calls: () => number;
} {
  if (!Array.isArray(outcomes) || outcomes.length > 10_000) {
    throw new RangeError('Fixture outcomes must contain at most 10,000 entries.');
  }
  const fixtures = outcomes.map((outcome) => copyJson(outcome, 10_000));
  for (const fixture of fixtures) {
    if (
      !fixture ||
      typeof fixture !== 'object' ||
      Array.isArray(fixture) ||
      Object.hasOwn(fixture, 'result') === Object.hasOwn(fixture, 'error')
    ) {
      throw new TypeError('Each service fixture must contain exactly one result or error.');
    }
    if (
      'error' in fixture &&
      (!fixture.error ||
        typeof fixture.error.code !== 'string' ||
        fixture.error.code.length < 1 ||
        fixture.error.code.length > 128 ||
        typeof fixture.error.message !== 'string' ||
        fixture.error.message.length > 2_000)
    ) {
      throw new TypeError('Fixture failures require a bounded code and message.');
    }
  }
  let index = 0;
  return {
    async handler() {
      const outcome = fixtures[index++];
      if (!outcome) throw new DoubleError('fixture-exhausted', 'No fixture remains for this call.');
      if ('error' in outcome) throw new DoubleError(outcome.error.code, outcome.error.message);
      return copyJson(outcome.result, 10_000);
    },
    calls: () => index,
  };
}

export function createIntegrationHarness(
  services: Readonly<Record<string, ServiceDouble>>,
  options: HarnessOptions = {},
): { run(steps: readonly ScenarioStep[], signal?: AbortSignal): Promise<HarnessResult> } {
  if (
    !services ||
    typeof services !== 'object' ||
    Array.isArray(services) ||
    Object.getPrototypeOf(services) !== Object.prototype
  ) {
    throw new TypeError('Services must be a plain object of injected handlers.');
  }
  const initialNow = options.now ?? 0;
  const maxCalls = options.maxCalls ?? 1_000;
  const maxNodes = options.maxNodes ?? 10_000;
  if (!Number.isSafeInteger(initialNow) || initialNow < 0) {
    throw new RangeError('now must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) {
    throw new RangeError('maxCalls must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new RangeError('maxNodes must be a positive safe integer.');
  }
  for (const name of Reflect.ownKeys(services)) {
    const descriptor =
      typeof name === 'string' ? Object.getOwnPropertyDescriptor(services, name) : null;
    if (
      !descriptor ||
      typeof name !== 'string' ||
      name.length < 1 ||
      name.length > 128 ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function'
    ) {
      throw new TypeError('Service names must be non-empty and every service must be a function.');
    }
  }
  let running = false;
  return {
    async run(steps, signal) {
      if (running) {
        throw new IntegrationHarnessError(
          'concurrent-run',
          'A harness instance cannot execute concurrent scenarios.',
        );
      }
      if (!Array.isArray(steps)) {
        throw new IntegrationHarnessError('invalid-input', 'Scenario steps must be an array.');
      }
      running = true;
      let now = initialNow;
      let calls = 0;
      const trace: HarnessResult['steps'][number][] = [];
      try {
        if (steps.length > maxCalls) {
          throw new IntegrationHarnessError(
            'call-limit',
            'Scenario exceeds the configured call limit.',
          );
        }
        for (const [stepIndex, step] of steps.entries()) {
          if (signal?.aborted) {
            throw new IntegrationHarnessError('aborted', 'Scenario was cancelled.');
          }
          if (
            !step ||
            typeof step.service !== 'string' ||
            !Object.hasOwn(step, 'input') ||
            !step.expect ||
            Object.hasOwn(step.expect, 'result') === Object.hasOwn(step.expect, 'errorCode')
          ) {
            throw new IntegrationHarnessError(
              'invalid-input',
              `Malformed scenario step ${stepIndex}.`,
            );
          }
          if (!Object.hasOwn(services, step.service)) {
            throw new IntegrationHarnessError(
              'unknown-service',
              `No injected service named "${step.service}".`,
            );
          }
          const handler = services[step.service]!;
          const advanceBy = step.advanceBy ?? 0;
          if (
            !Number.isSafeInteger(advanceBy) ||
            advanceBy < 0 ||
            !Number.isSafeInteger(now + advanceBy)
          ) {
            throw new IntegrationHarnessError(
              'invalid-input',
              `Step ${stepIndex} has an invalid clock advance.`,
            );
          }
          now += advanceBy;
          if (++calls > maxCalls) {
            throw new IntegrationHarnessError(
              'call-limit',
              'Scenario exceeds the configured call limit.',
            );
          }
          const input = copyJson(step.input, maxNodes);
          let output: HarnessJson = null;
          let failure: HarnessFailure | undefined;
          let rawOutput: HarnessJson = null;
          try {
            rawOutput = await handler(input, {
              now,
              callIndex: calls,
              ...(signal === undefined ? {} : { signal }),
            });
            if (signal?.aborted) {
              throw new IntegrationHarnessError(
                'aborted',
                'Scenario was cancelled by its service.',
              );
            }
          } catch (error) {
            if (error instanceof IntegrationHarnessError && error.code === 'aborted') throw error;
            failure = {
              code:
                error &&
                typeof error === 'object' &&
                'code' in error &&
                typeof error.code === 'string'
                  ? error.code
                  : error instanceof Error
                    ? error.name
                    : 'service-error',
              message: error instanceof Error ? error.message : 'Service double failed.',
            };
          }
          if (failure === undefined) output = copyJson(rawOutput, maxNodes);
          const expected = step.expect;
          if ('errorCode' in expected) {
            if (!failure || failure.code !== expected.errorCode) {
              throw new IntegrationHarnessError(
                'assertion-failed',
                `Step ${stepIndex} expected error "${expected.errorCode}".`,
              );
            }
          } else if (failure || !equalJson(output!, copyJson(expected.result, maxNodes))) {
            throw new IntegrationHarnessError(
              'assertion-failed',
              `Step ${stepIndex} result did not match its fixture.`,
            );
          }
          trace.push({
            service: step.service,
            input,
            ...(failure === undefined ? { result: output } : { error: failure }),
            now,
          });
        }
        return { now, assertions: steps.length, steps: trace };
      } finally {
        running = false;
      }
    },
  };
}
