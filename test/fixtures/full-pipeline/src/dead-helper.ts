// Pattern: dead code — this export is never imported anywhere in src/.
// Scanner should flag it as an unused export / orphan module.

export function unusedComputation(xs: number[]): number {
  return xs.reduce((acc, x) => acc + x * 2, 0);
}

export const NEVER_USED_CONSTANT = 42;
