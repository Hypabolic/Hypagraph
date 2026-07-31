/**
 * Vitest setup: keep existing same-session follow-up fixtures working.
 *
 * Product default is isolated-pi. Many older Pi extension tests still assert
 * orchestrator implement follow-ups. Those tests inject the legacy path only
 * through configureHostRoutingForTests — never through production env reads.
 */
import { configureHostRoutingForTests } from "../src/pi/host-routing-options.js";

configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
