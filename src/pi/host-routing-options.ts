/**
 * Host routing options for root model-lane dispatch.
 *
 * Production default is always isolated-pi for model tasks that omit an
 * executor profile. Tests may inject a legacy current-session default through
 * configureHostRoutingForTests only. Ambient environment variables must not
 * change production routing.
 */

export interface HostRoutingOptions {
  /**
   * When true, model nodes without an explicit profile resolve to current-session.
   * Production always uses false.
   */
  legacyCurrentSessionDefault: boolean;
}

const productionDefaults: HostRoutingOptions = {
  legacyCurrentSessionDefault: false,
};

let options: HostRoutingOptions = { ...productionDefaults };

/** Read the current host routing options (production or test-injected). */
export function getHostRoutingOptions(): HostRoutingOptions {
  return options;
}

/**
 * Test-only configuration.
 * Call from vitest setup or individual product tests. Never from production.
 */
export function configureHostRoutingForTests(partial: Partial<HostRoutingOptions>): void {
  options = {
    ...productionDefaults,
    ...partial,
  };
}

/** Restore production defaults after a test mutates routing options. */
export function resetHostRoutingOptionsForTests(): void {
  options = { ...productionDefaults };
}
