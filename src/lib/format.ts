export function formatGpsDegrees(degrees: number | null): string {
  if (degrees == null || !Number.isFinite(degrees)) return "—";
  return degrees.toFixed(6);
}

export function formatSeparation(meters: number | null): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${meters.toFixed(1)} m`;
}

/** Same two hex digits the board puts in its Bluetooth name. */
export function boardLabel(id: number): string {
  const hex = (id & 0xff).toString(16).toUpperCase().padStart(2, "0");
  return `Board ${hex}`;
}
