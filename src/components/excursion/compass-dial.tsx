"use client";

import { formatBearing, formatCompassBearing, formatDistance, wristbandName } from "@/lib/format";
import type { MemberState } from "@/lib/ble/app-client";
import type { CompassStatus } from "./use-heading";
import { Button } from "@/components/ui/button";

export function CompassDial({
  member,
  nicknames,
  heading,
  compassStatus,
  needsGesture,
  onEnableCompass,
}: {
  member: MemberState | null;
  nicknames: Record<string, string>;
  heading: number | null;
  compassStatus: CompassStatus;
  needsGesture: boolean;
  onEnableCompass: () => void;
}) {
  const angle = member?.angleDeg;
  const ticks = Array.from({ length: 24 }, (_, index) => index);
  const north = compassStatus === "on" && heading != null;

  return (
    <section className="rounded-3xl border bg-card p-4" aria-label="Direction">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-xl tracking-tight">Direction</h2>
        <p className="text-xs text-muted-foreground">
          {member ? wristbandName(member.deviceId, nicknames) : "No wristband selected"}
        </p>
      </div>

      <div className="relative mx-auto size-[240px]">
        <svg viewBox="0 0 200 200" className="size-full text-foreground" aria-hidden="true">
          <circle cx="100" cy="100" r="94" fill="none" stroke="currentColor" strokeOpacity="0.18" />
          <circle cx="100" cy="100" r="78" fill="none" stroke="currentColor" strokeOpacity="0.1" />
          {ticks.map((tick) => {
            const major = tick % 6 === 0;
            const radians = ((tick * 15 - 90) * Math.PI) / 180;
            const inner = major ? 70 : 74;
            const outer = 90;
            return (
              <line
                key={tick}
                x1={100 + inner * Math.cos(radians)}
                y1={100 + inner * Math.sin(radians)}
                x2={100 + outer * Math.cos(radians)}
                y2={100 + outer * Math.sin(radians)}
                stroke="currentColor"
                strokeOpacity={major ? 0.55 : 0.22}
                strokeWidth={major ? 1.6 : 1}
              />
            );
          })}
          <polygon points="100,18 96,28 104,28" fill="currentColor" opacity="0.45" />
          {north && (
            <g transform={`rotate(${-heading} 100 100)`}>
              <text
                x="100"
                y="44"
                textAnchor="middle"
                fill="currentColor"
                fontSize="11"
                fontFamily="ui-monospace, monospace"
              >
                N
              </text>
            </g>
          )}
          {angle != null && (
            <g transform={`rotate(${angle} 100 100)`}>
              <polygon points="100,34 107,86 100,76 93,86" className="fill-pine" />
            </g>
          )}
          <circle cx="100" cy="100" r="32" className="fill-card" />
          <circle cx="100" cy="100" r="2" fill="currentColor" />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
          <p className="font-mono text-[1.65rem] leading-none tracking-tight">
            {formatDistance(member?.distanceM ?? null)}
          </p>
          <p className="mt-1 max-w-[7.5rem] text-center text-[11px] leading-tight text-muted-foreground">
            {member ? formatBearing(member.angleDeg) : "Select a wristband"}
          </p>
        </div>
      </div>

      <p className="mt-1 text-center text-sm">
        {member?.angleDeg == null
          ? "LoRa can still carry a check-in. UWB has no direction."
          : "Top of the phone is straight ahead."}
      </p>
      {north && member?.angleDeg != null && (
        <p className="text-center font-mono text-xs text-muted-foreground">
          Compass {formatCompassBearing(heading, member.angleDeg)}
        </p>
      )}

      <div className="mt-3 flex flex-col items-center gap-2">
        {compassStatus !== "on" && (
          <Button type="button" variant="outline" className="h-10 px-3" onClick={onEnableCompass}>
            {needsGesture ? "Allow compass" : "Use phone compass"}
          </Button>
        )}
        <p className="max-w-xs text-center text-xs text-muted-foreground">
          {compassCopy(compassStatus)}
        </p>
      </div>
    </section>
  );
}

function compassCopy(status: CompassStatus): string {
  switch (status) {
    case "on":
      return "The arrow follows the beacon on the back of this phone. N is from the magnetometer.";
    case "denied":
      return "Compass permission is off. Direction is still relative to this phone.";
    case "unavailable":
      return "This browser did not report a north reference. Direction stays relative to the phone.";
    case "off":
      return "Absolute compass is optional. The arrow already points relative to the phone.";
  }
}
