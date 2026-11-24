"use client";

import { memo } from "react";
import type { TrackedFollower } from "@/lib/ble/app-client";
import { FollowerGps } from "./follower-gps";
import { useCompass } from "./use-compass";

export const LiveGps = memo(function LiveGps({ fix, lat, lon, radios }: {
  fix: boolean | null;
  lat: number | null;
  lon: number | null;
  radios: TrackedFollower[];
}) {
  const compass = useCompass();
  const leaderPosition = { fix, lat, lon };
  return (
    <section aria-label="Live GPS" className="mt-4 rounded-lg border border-neutral-300 bg-white p-3">
      <h3 className="text-sm font-semibold">Live GPS</h3>
      <p className="mt-1 text-sm tabular-nums text-neutral-600">
        {leaderPosition.fix && leaderPosition.lat != null && leaderPosition.lon != null
          ? `Leader PCB · ${leaderPosition.lat.toFixed(5)}, ${leaderPosition.lon.toFixed(5)}`
          : "Waiting for the leader PCB’s GPS fix."}
      </p>
      {compass.needsGesture && (
        <button type="button" className="mt-2 text-sm font-medium underline" onClick={() => void compass.enable()}>
          {compass.denied ? "Retry compass permission" : "Enable iPhone compass"}
        </button>
      )}
      {compass.heading != null && (
        <p className="mt-2 text-sm text-neutral-600">Hold the phone flat to follow the arrow on each follower card.</p>
      )}
      {radios.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-600">Waiting for the leader to hear other radios.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {radios.map((radio) => (
            <li key={radio.id} className="rounded-lg border border-neutral-200 p-3">
              <h4 className="text-sm font-semibold">
                {radio.name || `Node !${radio.id.toString(16).padStart(8, "0")}`}
              </h4>
              <FollowerGps leader={leaderPosition} follower={radio} heading={compass.heading} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
