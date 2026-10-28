/** Bearing from point 1 to point 2, degrees clockwise from true north. */
export function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const deltaLon = (lon2 - lon1) * toRad;
  const y = Math.sin(deltaLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);
  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

/** Clockwise degrees from the phone heading to the target. 0 is straight ahead. */
export function relativeBearing(targetDegrees: number, headingDegrees: number): number {
  return normalizeDegrees(targetDegrees - headingDegrees);
}

export function isOutOfRange(
  known: boolean | null,
  meters: number | null,
  limitMeters: number,
): boolean {
  return known === true && meters != null && Number.isFinite(meters) && meters > limitMeters;
}

export function cardinalLabel(degrees: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalizeDegrees(degrees) / 45) % 8;
  return names[index];
}

/** Short instruction for the arrow. `relativeDegrees` is clockwise from the top of the phone. */
export function guideCue(relativeDegrees: number): string {
  const turn = normalizeDegrees(relativeDegrees);
  const signed = turn > 180 ? turn - 360 : turn;
  if (Math.abs(signed) <= 20) return "Straight ahead";
  if (signed > 0) return "Turn right";
  return "Turn left";
}

export interface OrientationSample {
  webkitCompassHeading?: number | null;
  alpha?: number | null;
  absolute?: boolean | null;
}

/** Phone heading clockwise from north, when the event actually carries one. */
export function headingFromOrientation(sample: OrientationSample): number | null {
  const ios = sample.webkitCompassHeading;
  if (typeof ios === "number" && Number.isFinite(ios)) return normalizeDegrees(ios);
  if (typeof sample.alpha === "number" && Number.isFinite(sample.alpha)) {
    return normalizeDegrees(360 - sample.alpha);
  }
  return null;
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
