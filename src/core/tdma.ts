/**
 * Thomas algorithm for a tridiagonal system.
 *   a[i] T[i-1] + b[i] T[i] + c[i] T[i+1] = d[i], i = 0..n-1
 * a[0] and c[n-1] are ignored. Arrays are not mutated.
 */
export function tdmaSolve(
  a: number[],
  b: number[],
  c: number[],
  d: number[],
): number[] {
  const n = b.length;
  if (n === 0) throw new Error('tdma: empty system');
  const cp = new Array<number>(n);
  const dp = new Array<number>(n);
  cp[0] = c[0] / b[0];
  dp[0] = d[0] / b[0];
  for (let i = 1; i < n; i++) {
    const denom = b[i] - a[i] * cp[i - 1];
    if (denom === 0) throw new Error('tdma: zero pivot');
    cp[i] = i < n - 1 ? c[i] / denom : 0;
    dp[i] = (d[i] - a[i] * dp[i - 1]) / denom;
  }
  const x = new Array<number>(n);
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    x[i] = dp[i] - cp[i] * x[i + 1];
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i])) {
      const err = new Error('non-finite solution');
      (err as Error & { code?: string }).code = 'SOLVER_NON_FINITE';
      throw err;
    }
  }
  return x;
}
