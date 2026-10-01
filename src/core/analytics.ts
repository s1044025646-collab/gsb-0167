import type { LayerSpec } from './types.js';

export interface SteadyResult {
  q: number; // heat flux in +x [W/m2]
  T: (x: number) => number;
  resistance: number; // total conductive R [m2 K/W]
}

/**
 * Exact steady 1-D conduction through layers in series with prescribed
 * face temperatures TL (x=0) and TR (x=Ltot).
 */
export function steadySeries(layers: LayerSpec[], TL: number, TR: number): SteadyResult {
  const boundaries: { x0: number; x1: number; k: number }[] = [];
  let x = 0;
  let R = 0;
  for (const l of layers) {
    boundaries.push({ x0: x, x1: x + l.thickness, k: l.k });
    R += l.thickness / l.k;
    x += l.thickness;
  }
  const Ltot = x;
  const q = (TL - TR) / R;
  const T = (xp: number) => {
    for (const b of boundaries) {
      if (xp <= b.x1) {
        const dropBefore = boundaries
          .filter((bb) => bb.x1 <= b.x0 + 1e-12 && bb !== b)
          .reduce((acc, bb) => acc + q * ((bb.x1 - bb.x0) / bb.k), 0);
        const TLface = TL - dropBefore;
        const TRface = TLface - q * ((b.x1 - b.x0) / b.k);
        const xi = Math.min(Math.max(xp, b.x0), b.x1);
        return TLface + ((TRface - TLface) * (xi - b.x0)) / (b.x1 - b.x0);
      }
    }
    return TR;
  };
  void Ltot;
  return { q, T, resistance: R };
}

/**
 * Transient analytic solution for a single homogeneous slab initially at
 * uniform Ti with prescribed face temperatures TL (x=0) and TR (x=L):
 *
 *   T(x,t) = TL + (TR-TL)x/L + sum_n b_n sin(n pi x/L) exp(-alpha n^2 pi^2 t/L^2)
 *   alpha   = k/(rho cp)
 *   b_n     = 2/(n pi) [ (Ti-TL)(1-(-1)^n) + (TR-TL)(-1)^n ]
 */
export function slabSeries(
  layer: LayerSpec,
  TL: number,
  TR: number,
  terms = 400,
): (x: number, t: number) => number {
  const L = layer.thickness;
  const alpha = layer.k / (layer.rho * layer.cp);
  const Ti = layer.T0;
  return (x: number, t: number) => {
    let s = TL + ((TR - TL) * x) / L;
    if (t <= 0) return Ti;
    for (let n = 1; n <= terms; n++) {
      const sign = n % 2 === 0 ? 1 : -1;
      const bn = (2 / (n * Math.PI)) * ((Ti - TL) * (1 - sign) + (TR - TL) * sign);
      s += bn * Math.sin((n * Math.PI * x) / L) * Math.exp(-alpha * n * n * Math.PI * Math.PI * t / (L * L));
    }
    return s;
  };
}

export interface RefinementRow {
  label: string;
  nCells: number;
  dt: number;
  tEnd: number;
  Tprobe: number;
  maxAbsErrVsFine: number;
  energyResidual: number;
}

export function maxAbsDiff(a: number[], b: number[]): number {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Linear interpolation of a cell-centered vector onto another cell grid. */
export function interpolateTo(gridXc: number[], xc: number[], T: number[]): number[] {
  return gridXc.map((x) => {
    if (x <= xc[0]) return T[0];
    if (x >= xc[xc.length - 1]) return T[T.length - 1];
    for (let i = 0; i < xc.length - 1; i++) {
      if (x >= xc[i] && x <= xc[i + 1]) {
        const f = (x - xc[i]) / (xc[i + 1] - xc[i]);
        return T[i] + f * (T[i + 1] - T[i]);
      }
    }
    return T[T.length - 1];
  });
}
