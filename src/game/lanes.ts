/** Supported play-field sizes. Four lanes stays the default for old saves. */
export const LANE_COUNTS = [4, 6, 8] as const;
export type LaneCount = (typeof LANE_COUNTS)[number];

export const DEFAULT_LANE_COUNT: LaneCount = 4;

/** Comfortable two-hand defaults for every supported field size. */
export const DEFAULT_KEYS_BY_LANE_COUNT: Record<LaneCount, string[]> = {
  4: ['d', 'f', 'j', 'k'],
  6: ['s', 'd', 'f', 'j', 'k', 'l'],
  8: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'],
};

export function isLaneCount(value: unknown): value is LaneCount {
  return typeof value === 'number' && LANE_COUNTS.includes(value as LaneCount);
}

export function defaultKeysFor(laneCount: LaneCount): string[] {
  return [...DEFAULT_KEYS_BY_LANE_COUNT[laneCount]];
}

/**
 * Upgrade old four-key settings and repair incomplete/custom key arrays.
 * Existing bindings are retained whenever possible; missing lanes receive the
 * default key for that position without introducing duplicate bindings.
 */
export function normaliseLaneSettings(
  laneCountValue: unknown,
  keysValue: unknown,
): { laneCount: LaneCount; keys: string[] } {
  const rawKeys = Array.isArray(keysValue)
    ? keysValue.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : [];
  const inferred = isLaneCount(rawKeys.length) ? rawKeys.length : DEFAULT_LANE_COUNT;
  const laneCount = isLaneCount(laneCountValue) ? laneCountValue : inferred;
  const defaults = defaultKeysFor(laneCount);
  const keys: string[] = [];

  for (let lane = 0; lane < laneCount; lane++) {
    const requested = rawKeys[lane] ?? defaults[lane];
    const fallback = defaults[lane];
    const key = keys.includes(requested) ? fallback : requested;
    keys.push(keys.includes(key) ? `F${lane + 1}` : key);
  }

  return { laneCount, keys };
}
