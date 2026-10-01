import type { BoundaryCondition, BoundaryHistory, LayerInput } from './types.ts';
import { constantHistory } from './boundary.ts';

/** Fictional materials — names and property values are invented for tests/demo. */
export const MATERIALS: Record<
  string,
  { conductivity: number; density: number; specificHeat: number; description: string }
> = {
  aerogel_x: {
    conductivity: 0.025,
    density: 120,
    specificHeat: 950,
    description: 'fictional insulation, low conductivity',
  },
  concrete_y: {
    conductivity: 1.4,
    density: 2200,
    specificHeat: 850,
    description: 'fictional dense structural layer',
  },
  alloy_z: {
    conductivity: 55,
    density: 7800,
    specificHeat: 460,
    description: 'fictional high conductivity alloy (conductivity contrast layer)',
  },
};

export function layer(
  material: keyof typeof MATERIALS,
  thickness: number,
  cells: number,
  name?: string,
): LayerInput {
  const m = MATERIALS[material];
  return {
    name: name ?? String(material),
    thickness,
    conductivity: m.conductivity,
    density: m.density,
    specificHeat: m.specificHeat,
    cells,
  };
}

export const temp = (value: number): BoundaryCondition => ({ type: 'temperature', value });
export const adiabatic = (): BoundaryCondition => ({ type: 'adiabatic' });
export const convection = (fluidTemperature: number, htc: number): BoundaryCondition => ({
  type: 'convection',
  fluidTemperature,
  htc,
});

export const h = (c: BoundaryCondition): BoundaryHistory => constantHistory(c);

/**
 * Piecewise history: stepTimes/conditions define constant pieces.
 * The final condition is held to Infinity.
 */
export function stepHistory(
  initial: BoundaryCondition,
  ...steps: { at: number; condition: BoundaryCondition }[]
): BoundaryHistory {
  const ordered = [...steps].sort((a, b) => a.at - b.at);
  const segments = [{ start: 0, end: ordered[0]?.at ?? Infinity, condition: initial }];
  for (let i = 0; i < ordered.length; i++) {
    segments.push({
      start: ordered[i].at,
      end: ordered[i + 1]?.at ?? Infinity,
      condition: ordered[i].condition,
    });
  }
  return { segments };
}

export interface Fixture {
  key: string;
  description: string;
  build: () => {
    layers: LayerInput[];
    initialTemperature: number;
    left: BoundaryHistory;
    right: BoundaryHistory;
  };
}

export const FIXTURES: Fixture[] = [
  {
    key: 'uniform-adiabatic',
    description: 'single fictional layer, both faces adiabatic, uniform temperature',
    build: () => ({
      layers: [layer('concrete_y', 0.2, 10)],
      initialTemperature: 300,
      left: h(adiabatic()),
      right: h(adiabatic()),
    }),
  },
  {
    key: 'both-fixed',
    description: 'single layer, fixed temperatures at both ends',
    build: () => ({
      layers: [layer('concrete_y', 0.3, 30)],
      initialTemperature: 300,
      left: h(temp(400)),
      right: h(temp(300)),
    }),
  },
  {
    key: 'multilayer-resistance',
    description: 'three layers with strong conductivity contrast, fixed end temperatures',
    build: () => ({
      layers: [
        layer('alloy_z', 0.05, 20),
        layer('aerogel_x', 0.1, 40),
        layer('concrete_y', 0.1, 20),
      ],
      initialTemperature: 290,
      left: h(temp(370)),
      right: h(temp(300)),
    }),
  },
  {
    key: 'convection-cooling',
    description: 'single layer cooling into equal convection on both faces',
    build: () => ({
      layers: [layer('concrete_y', 0.2, 20)],
      initialTemperature: 350,
      left: h(convection(290, 12)),
      right: h(convection(290, 12)),
    }),
  },
  {
    key: 'step-heating',
    description: 'adiabatic until t=600s, then a fixed hot face (boundary step)',
    build: () => ({
      layers: [layer('aerogel_x', 0.08, 32)],
      initialTemperature: 300,
      left: stepHistory(adiabatic(), { at: 600, condition: temp(450) }),
      right: h(adiabatic()),
    }),
  },
];
