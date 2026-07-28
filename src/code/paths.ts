import { canonicalProtectedPath } from "../domain/integrity-policy.js";

/**
 * Canonicalise a workspace-relative path for capability and scope checks.
 * Reject absolute paths and parent-segment escapes.
 */
export function canonicalWorkspacePath(value: string): string | undefined {
  return canonicalProtectedPath(value);
}

/**
 * Report whether a path is allowed by a declared path allowlist.
 * Both the path and each allowlist entry are canonicalised first.
 */
export function pathMatchesAllowlist(path: string, allowed: readonly string[]): boolean {
  const normalised = canonicalWorkspacePath(path);
  if (!normalised) return false;
  return allowed.some((entry) => {
    const prefix = canonicalWorkspacePath(entry);
    if (!prefix) return false;
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  });
}
