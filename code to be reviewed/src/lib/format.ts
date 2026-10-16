export function formatUwbDistance(meters: number | null): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${meters.toFixed(2)} m`;
}
