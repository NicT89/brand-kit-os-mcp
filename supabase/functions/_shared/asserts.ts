// Minimal, dependency-free reimplementation of the subset of the Deno standard
// library's assertion helpers used by this repo's Deno test suite
// (`assert`, `assertEquals`, `assertExists`, `assertNotEquals`).
//
// Why this exists: the test files previously imported from `jsr:@std/assert`
// (and a couple from `https://deno.land/std/.../assert`). Fetching those at test
// time requires outbound network access to jsr.io / deno.land, which is blocked
// by the egress policy in restricted sandboxes — so `npm run test:mcp-contract`
// could not run locally and CI was the only place the tests executed. Importing
// these helpers locally makes the Deno tests hermetic (no network), so they run
// anywhere. The signatures mirror @std/assert 1:1, so swapping back is trivial
// if/when jsr.io egress is available.

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/** Make an assertion; throws AssertionError if `expr` is falsy. */
export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) throw new AssertionError(msg || "Expression is falsy.");
}

/** Structural deep equality used by assertEquals / assertNotEquals. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/** Assert that `actual` and `expected` are deeply equal. */
export function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (equal(actual, expected)) return;
  throw new AssertionError(
    msg ||
      `Values are not equal.\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  );
}

/** Assert that `actual` and `expected` are NOT deeply equal. */
export function assertNotEquals<T>(actual: T, expected: T, msg = ""): void {
  if (!equal(actual, expected)) return;
  throw new AssertionError(
    msg || `Values should not be equal, but both are: ${JSON.stringify(actual)}`,
  );
}

/** Assert that `actual` is neither null nor undefined. */
export function assertExists<T>(
  actual: T,
  msg = "",
): asserts actual is NonNullable<T> {
  if (actual === null || actual === undefined) {
    throw new AssertionError(msg || `Expected actual to exist but received ${actual}.`);
  }
}
