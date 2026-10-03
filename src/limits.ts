export const LIMITS = {
  MIN_SIDE: 3,
  MAX_WIDTH: 200,
  MAX_HEIGHT: 200,
  MAX_AREA: 10000,
  MAX_STEPS: 10000,
  MAX_SNAPSHOTS: 1024,
} as const;

export interface LimitsView {
  minSide: number;
  maxWidth: number;
  maxHeight: number;
  maxArea: number;
  maxSteps: number;
  maxSnapshots: number;
}

export function limitsView(): LimitsView {
  return {
    minSide: LIMITS.MIN_SIDE,
    maxWidth: LIMITS.MAX_WIDTH,
    maxHeight: LIMITS.MAX_HEIGHT,
    maxArea: LIMITS.MAX_AREA,
    maxSteps: LIMITS.MAX_STEPS,
    maxSnapshots: LIMITS.MAX_SNAPSHOTS,
  };
}
