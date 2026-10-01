import type { LayerInput } from './types.ts';

/** Steady-state heat flux density through a series multilayer wall [W/m^2]. */
export function steadyFlux(layers: LayerInput[], tLeft: number, tRight: number): number {
  const r = layers.reduce((sum, l) => sum + l.thickness / l.conductivity, 0);
  return (tLeft - tRight) / r;
}

/** Steady temperature at position x for prescribed surface temperatures. */
export function steadyTemperatureAt(layers: LayerInput[], x: number, tLeft: number, tRight: number): number {
  const totalR = layers.reduce((s, l) => s + l.thickness / l.conductivity, 0);
  const q = (tLeft - tRight) / totalR;
  let acc = 0;
  let rAcc = 0;
  for (const l of layers) {
    if (x <= acc + l.thickness) {
      return tLeft - q * (rAcc + (x - acc) / l.conductivity);
    }
    rAcc += l.thickness / l.conductivity;
    acc += l.thickness;
  }
  return tRight;
}

export interface SlabParams {
  thickness: number;
  conductivity: number;
  density: number;
  specificHeat: number;
}

/**
 * Single slab, uniform initial temperature, equal convection on both faces.
 * Series solution on the symmetric domain. Coordinate x in [0, L],
 * half-thickness a = L/2, Bi = h a / k, Fo = alpha t / a^2.
 * Eigenvalues satisfy z tan z = Bi.
 */
export function slabConvectionSeries(
  p: SlabParams,
  initial: number,
  fluid: number,
  htc: number,
  x: number,
  time: number,
  terms = 200,
  tolerance = 1e-12,
): number {
  const alpha = p.conductivity / (p.density * p.specificHeat);
  const a = p.thickness / 2;
  const bi = (htc * a) / p.conductivity;
  const fo = (alpha * time) / (a * a);
  const r = (x - a) / a; // [-1, 1]

  let sum = 0;
  for (let n = 1; n <= terms; n++) {
    const z = eigenZ(n, bi);
    const c = (4 * Math.sin(z)) / (2 * z + Math.sin(2 * z));
    const term = c * Math.exp(-z * z * fo) * Math.cos(z * r);
    sum += term;
    if (Math.abs(term) < tolerance && n > 4) break;
  }
  return fluid + (initial - fluid) * sum;
}

/** nth positive root of z tan z = bi via bisection. */
function eigenZ(n: number, bi: number): number {
  // Root n lies in ((n-1)pi, (n-0.5)pi)
  let lo = (n - 1) * Math.PI + 1e-9;
  let hi = (n - 0.5) * Math.PI - 1e-12;
  const f = (z: number) => z * Math.tan(z) - bi;
  let flo = f(lo);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-13) return mid;
    if (flo * fm <= 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Single slab, uniform initial temperature, fixed temperatures at both ends.
 * Steady linear profile plus decaying sine series.
 */
export function slabFixedEndsSeries(
  p: SlabParams,
  initial: number,
  tLeft: number,
  tRight: number,
  x: number,
  time: number,
  terms = 4000,
): number {
  const alpha = p.conductivity / (p.density * p.specificHeat);
  const L = p.thickness;
  const steady = tLeft + ((tRight - tLeft) * x) / L;
  let series = 0;
  for (let n = 1; n <= terms; n++) {
    const c = Math.cos(n * Math.PI);
    const bn =
      (2 / (n * Math.PI)) *
      ((initial - tLeft) * (1 - c) + (tRight - tLeft) * c);
    const decay = Math.exp(-alpha * ((n * Math.PI) / L) ** 2 * time);
    const term = bn * Math.sin((n * Math.PI * x) / L) * decay;
    series += term;
    if (Math.abs(term) < 1e-13 && n > 10) break;
  }
  return steady + series;
}
