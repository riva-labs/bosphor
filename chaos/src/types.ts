/**
 * A chaos scenario injects one controlled failure against the running system
 * and asserts that it recovers. Each scenario is self-contained: it sets up,
 * injects the fault, observes, and returns a structured result. A scenario
 * should not throw for an expected failed assertion; it returns a failing
 * result instead. An unexpected throw is caught by the runner and turned into a
 * failing result so one broken scenario never aborts the run.
 */
export interface Scenario {
  /** Stable machine name, e.g. `relayer-crash-midflight`. */
  name: string;
  /** One-line human description of what is being tested. */
  description: string;
  /** Execute the scenario and report what happened. */
  run(): Promise<ScenarioOutcome>;
}

/** What a scenario reports about its own run (before the runner stamps timing). */
export interface ScenarioOutcome {
  /** Did the system recover as expected? */
  recovered: boolean;
  /** Human-readable evidence lines collected while running. */
  evidence: string[];
  /** Set when recovered is false: why recovery was not observed. */
  error?: string;
}

/** A scenario outcome enriched by the runner with identity and timing. */
export interface ScenarioResult extends ScenarioOutcome {
  name: string;
  description: string;
  status: 'pass' | 'fail';
  durationMs: number;
}

/** The consolidated result of a full chaos run. */
export interface RecoveryReport {
  total: number;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}
