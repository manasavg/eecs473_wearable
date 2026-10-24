export function formatGpsDegrees(degrees: number | null): string {
  if (degrees == null || !Number.isFinite(degrees)) return "—";
  return degrees.toFixed(6);
}

export function formatSeparation(meters: number | null): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${meters.toFixed(1)} m`;
}
