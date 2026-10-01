import type { BoundaryHistory, LayerSpec } from '../core/types.js';
import { buildHistory } from '../core/boundary.js';

/**
 * FICTIONAL materials for repeatable tests and demos only.
 * Values are plausible engineering numbers but belong to no real product.
 */
export const MATERIALS = {
  foamLight: { name: 'foamLight', k: 0.04, rho: 40, cp: 1500 },
  brickLite: { name: 'brickLite', k: 0.8, rho: 1600, cp: 900 },
  metalSoft: { name: 'metalSoft', k: 200, rho: 8000, cp: 450 },
  coatThin: { name: 'coatThin', k: 0.25, rho: 1200, cp: 1000 },
} as const;

export type MaterialName = keyof typeof MATERIALS;

export interface WallTemplate {
  name: string;
  layers: LayerSpec[];
}

function layer(
  material: (typeof MATERIALS)[MaterialName],
  thickness: number,
  n: number,
  T0: number,
  nameOverride?: string,
): LayerSpec {
  return { name: nameOverride ?? material.name, thickness, n, T0, k: material.k, rho: material.rho, cp: material.cp };
}

/** Uniform insulated slab: no heat enters -> temperature must never move. */
export function uniformInsulated(): { wall: WallTemplate; left: BoundaryHistory; right: BoundaryHistory } {
  const wall: WallTemplate = {
    name: 'uniform-insulated',
    layers: [layer(MATERIALS.brickLite, 0.2, 8, 20)],
  };
  return {
    wall,
    left: buildHistory('L', [{ t: 0, bc: { kind: 'insulated' } }]),
    right: buildHistory('R', [{ t: 0, bc: { kind: 'insulated' } }]),
  };
}

/** Single slab, both ends held at fixed temperatures (series-solution check). */
export function twoEndsConstant(TL = 0, TR = 100): { wall: WallTemplate; left: BoundaryHistory; right: BoundaryHistory } {
  const wall: WallTemplate = {
    name: 'two-ends-constant',
    layers: [layer(MATERIALS.brickLite, 0.2, 10, 25)],
  };
  return {
    wall,
    left: buildHistory('L', [{ t: 0, bc: { kind: 'temperature', T: TL } }]),
    right: buildHistory('R', [{ t: 0, bc: { kind: 'temperature', T: TR } }]),
  };
}

/** foamLite/brickLite/metalSoft composite; steady series-resistance check
 *  and interface-flux continuity with a 5000:1 conductivity jump. */
export function multilayerSteady(): { wall: WallTemplate; left: BoundaryHistory; right: BoundaryHistory } {
  const T0 = 20;
  const wall: WallTemplate = {
    name: 'multilayer-steady',
    layers: [
      layer(MATERIALS.foamLight, 0.05, 5, T0),
      layer(MATERIALS.brickLite, 0.1, 10, T0),
      layer(MATERIALS.metalSoft, 0.02, 4, T0),
    ],
  };
  return {
    wall,
    left: buildHistory('L', [{ t: 0, bc: { kind: 'temperature', T: 80 } }]),
    right: buildHistory('R', [{ t: 0, bc: { kind: 'temperature', T: 20 } }]),
  };
}

/** Hot slab cooling by convection on both sides to cooler ambient. */
export function convectionCooling(): { wall: WallTemplate; left: BoundaryHistory; right: BoundaryHistory } {
  const wall: WallTemplate = {
    name: 'convection-cooling',
    layers: [layer(MATERIALS.coatThin, 0.1, 12, 100)],
  };
  return {
    wall,
    left: buildHistory('L', [{ t: 0, bc: { kind: 'convection', h: 15, Tinf: 20 } }]),
    right: buildHistory('R', [{ t: 0, bc: { kind: 'convection', h: 15, Tinf: 20 } }]),
  };
}

/** Step heating: insulated right, temperature step on the left at t = tStep. */
export function stepHeating(tStep = 3600): { wall: WallTemplate; left: BoundaryHistory; right: BoundaryHistory } {
  const wall: WallTemplate = {
    name: 'step-heating',
    layers: [layer(MATERIALS.brickLite, 0.2, 16, 20)],
  };
  return {
    wall,
    left: buildHistory('L', [
      { t: 0, bc: { kind: 'insulated' } },
      { t: tStep, bc: { kind: 'temperature', T: 120 } },
    ]),
    right: buildHistory('R', [{ t: 0, bc: { kind: 'insulated' } }]),
  };
}
