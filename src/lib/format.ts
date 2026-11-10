export function formatGpsDegrees(degrees: number | null): string {
  if (degrees == null || !Number.isFinite(degrees)) return "—";
  return degrees.toFixed(6);
}

export function formatSeparation(meters: number | null): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${meters.toFixed(1)} m`;
}

/** Node number in hex. Small ids stay two digits; Meshtastic ids print in full. */
export function boardLabel(id: number): string {
  const hex = (id >>> 0).toString(16).toUpperCase();
  return `Board ${hex.length < 2 ? hex.padStart(2, "0") : hex}`;
}
