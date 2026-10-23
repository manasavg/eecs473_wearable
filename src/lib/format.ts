export function formatGpsDegrees(degrees: number | null): string {
  if (degrees == null || !Number.isFinite(degrees)) return "—";
  return degrees.toFixed(6);
}
