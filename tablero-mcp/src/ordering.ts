// Keep in sync with src/ordering.ts of the tablero web app: both write card positions to the same collection.
export const POSITION_STEP = 1024
export const MIN_GAP = 0.001

export function positionBetween(prev: number | undefined, next: number | undefined): number | null {
  if (prev === undefined) return next === undefined ? POSITION_STEP : next - POSITION_STEP
  if (next === undefined) return prev + POSITION_STEP
  return next - prev < MIN_GAP ? null : (prev + next) / 2
}

export function positionAtEnd(positions: number[]): number {
  return positions.length === 0 ? POSITION_STEP : Math.max(...positions) + POSITION_STEP
}
