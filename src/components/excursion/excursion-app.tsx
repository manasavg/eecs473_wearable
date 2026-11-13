"use client";

import { useEffect, useRef, useState } from "react";
import { BROADCAST_ID, THRESHOLD_MAX_M, THRESHOLD_MIN_M } from "@/lib/ble/constants";
import type { TrackedFollower } from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { bearingDegrees, cardinalLabel, guideCue, relativeBearing } from "@/lib/geo";
import { boardLabel, formatGpsDegrees, formatSeparation } from "@/lib/format";
import { ensureNotifyPermission, notifyOutOfRange } from "@/lib/notify";
import { BLE_NAME_PREFIX } from "@/lib/ble/uuids";
import { useCompass } from "./use-compass";
import { useExcursion } from "./use-excursion";

export function ExcursionApp() {
  const app = useExcursion();
  const { state } = app;
  const compass = useCompass();
  const linked = state.connection === "connected";
  const onLink = state.mode !== "idle";
  const [ble, setBle] = useState<boolean | null>(null);
  const [nativeShell, setNativeShell] = useState(false);
  const [rangeDraft, setRangeDraft] = useState(String(state.thresholdMeters));
  const [looked, setLooked] = useState(false);
  const wasOut = useRef<Record<number, boolean>>({});

  useEffect(() => {
    const native = isNativeShell();
    setNativeShell(native);
    setBle(native || webBluetoothAvailable());
  }, []);

  useEffect(() => {
    setRangeDraft(String(state.thresholdMeters));
  }, [state.thresholdMeters]);

  useEffect(() => {
    const next: Record<number, boolean> = {};
    for (const follower of state.followers) {
      const previous = wasOut.current[follower.id] ?? false;
      if (follower.outOfRange && !previous && follower.separationM != null) {
        void notifyOutOfRange(follower.separationM, state.thresholdMeters, boardLabel(follower.id));
      }
      next[follower.id] = follower.outOfRange;
    }
    wasOut.current = next;
  }, [state.followers, state.thresholdMeters]);

  const checkInLabel = state.groupOkAt
    ? state.groupOkId != null
      ? `${boardLabel(state.groupOkId)} is OK`
      : "They're OK"
    : state.groupCheckInAt
      ? "Waiting for OK"
      : "Not sent";
  const outFollowers = state.followers.filter((follower) => follower.outOfRange);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
      <h1 className="text-xl font-semibold">Excursion</h1>

      {!onLink ? (
        <div className="mt-6 flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Three boards, one sketch. Pick any {BLE_NAME_PREFIX} board. That one becomes the leader.
            The other two are followers until you disconnect and pick a different board.
          </p>
          {(state.error || app.scanError) && (
            <p className="text-sm text-red-700" role="alert">
              {state.error || app.scanError}
            </p>
          )}
          {nativeShell ? (
            <>
              <button
                type="button"
                className="h-11 border border-black bg-black text-white disabled:opacity-40"
                disabled={ble === false || app.busy || app.scanning}
                onClick={() => {
                  setLooked(true);
                  void app.lookForDevices();
                }}
              >
                {app.scanning ? "Looking" : "Find devices"}
              </button>
              {app.scanning && app.peers.length === 0 && (
                <p className="text-sm text-neutral-600">Looking for Excursion boards…</p>
              )}
              {app.peers.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {app.peers.map((peer) => (
                    <li key={peer.deviceId}>
                      <button
                        type="button"
                        className="flex h-14 w-full items-center justify-between border border-neutral-300 bg-white px-3 text-left disabled:opacity-40"
                        disabled={app.busy}
                        onClick={() => void app.connectPeer(peer)}
                      >
                        <span className="font-medium">{peer.name}</span>
                        <span className="text-sm text-neutral-600">
                          {app.busy ? "Connecting" : "Make leader"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {looked && !app.scanning && app.peers.length === 0 && !app.scanError && (
                <p className="text-sm text-neutral-600">
                  No Excursion boards in range. Power all three on, then look again.
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              className="h-11 border border-black bg-black text-white disabled:opacity-40"
              disabled={ble === false || app.busy}
              onClick={() => void app.connectBeacon(false)}
            >
              {app.busy ? "Connecting" : "Connect"}
            </button>
          )}
          {app.rememberedName && (
            <button
              type="button"
              className="h-11 border border-neutral-300 bg-white disabled:opacity-40"
              disabled={app.busy}
              onClick={() => void app.connectBeacon(true)}
            >
              Reconnect {app.rememberedName}
            </button>
          )}
          {ble === false && (
            <p className="text-sm text-neutral-600">
              {nativeShell
                ? "Bluetooth is unavailable."
                : "This browser has no Bluetooth. On iPhone, run the Xcode app."}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {outFollowers.length > 0 && (
            <div className="border border-red-700 bg-red-50 px-3 py-3 text-sm text-red-800" role="alert">
              {outFollowers.map((follower) => (
                <p key={follower.id}>
                  {boardLabel(follower.id)} is out of range
                  {follower.separationM != null ? ` · ${formatSeparation(follower.separationM)}` : ""}. Limit{" "}
                  {state.thresholdMeters} m.
                </p>
              ))}
            </div>
          )}
          <p className="text-sm text-neutral-600">
            {state.connection === "connected"
              ? "Leader"
              : state.connection === "reconnecting"
                ? "Reconnecting"
                : state.connection === "scanning"
                  ? "Connecting"
                  : "Disconnected"}
            {state.deviceName ? ` · ${state.deviceName}` : ""}
          </p>
          <p className="text-sm text-neutral-600">
            This board is using the app. The other two are followers. Disconnect to choose a different leader.
          </p>
          {state.error && (
            <p className="text-sm text-red-700" role="alert">
              {state.error}{" "}
              <button type="button" className="underline" onClick={app.dismissError}>
                Dismiss
              </button>
            </p>
          )}

          <section>
            <h2 className="text-sm font-medium">LoRa</h2>
            <p className="mt-2 text-2xl">{checkInLabel}</p>
            <button
              type="button"
              className="mt-3 h-11 w-full border border-black bg-black text-white disabled:opacity-40"
              disabled={!linked || app.busy}
              onClick={() => void app.checkIn(BROADCAST_ID)}
            >
              Check in
            </button>
            <p className="mt-2 text-sm text-neutral-600">
              Writes the leader radio. A follower sends OK back over LoRa, then this line names that board.
            </p>
            {state.liveLink?.counter != null && (
              <p className="mt-2 text-sm text-neutral-500">Link counter {state.liveLink.counter}</p>
            )}
          </section>

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">Followers</h2>
            <p className="mt-2 text-sm text-neutral-600">
              {state.followers.length === 0
                ? "Waiting for the other boards. They answer over LoRa once this leader asks."
                : "Direction and distance for each follower. Both GPS antennas need a view of the sky."}
            </p>
            {(compass.needsGesture || compass.heading == null) && (
              <button
                type="button"
                className="mt-3 h-11 w-full border border-black bg-white"
                onClick={() => void compass.enable()}
              >
                Use compass
              </button>
            )}
            {compass.denied && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                Compass permission was denied. Each arrow stays aligned to north.
              </p>
            )}
            <div className="mt-4 flex flex-col gap-4">
              {state.followers.map((follower) => (
                <FollowerCard
                  key={follower.id}
                  follower={follower}
                  leaderFix={state.gpsFix}
                  leaderLat={state.gpsLat}
                  leaderLon={state.gpsLon}
                  heading={compass.heading}
                />
              ))}
            </div>
          </section>

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">Range</h2>
            <form
              className="mt-3 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const meters = Number.parseInt(rangeDraft, 10);
                if (!Number.isFinite(meters)) return;
                void (async () => {
                  await ensureNotifyPermission();
                  await app.setRange(meters);
                })();
              }}
            >
              <input
                type="number"
                inputMode="numeric"
                min={THRESHOLD_MIN_M}
                max={THRESHOLD_MAX_M}
                step={1}
                value={rangeDraft}
                aria-label="Out of range distance in meters"
                className="h-11 w-28 border border-neutral-300 px-3 tabular-nums"
                onChange={(event) => setRangeDraft(event.target.value)}
              />
              <span className="text-sm text-neutral-600">meters</span>
              <button
                type="submit"
                className="h-11 border border-black bg-black px-4 text-white disabled:opacity-40"
                disabled={!linked || app.busy}
              >
                Set
              </button>
            </form>
            <p className="mt-2 text-sm text-neutral-600">
              Whole meters, from {THRESHOLD_MIN_M} to {THRESHOLD_MAX_M}. Past this, that follower light
              stays on and this phone notifies you.
            </p>
          </section>

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">Leader GPS</h2>
            {state.gpsFix === true ? (
              <div className="mt-2">
                <p className="text-sm text-neutral-600">Latitude</p>
                <p className="text-2xl tabular-nums">{formatGpsDegrees(state.gpsLat)}</p>
                <p className="mt-2 text-sm text-neutral-600">Longitude</p>
                <p className="text-2xl tabular-nums">{formatGpsDegrees(state.gpsLon)}</p>
              </div>
            ) : (
              <p className="mt-2 text-4xl">{state.gpsFix === false ? "No fix" : "—"}</p>
            )}
            <p className="mt-2 text-sm text-neutral-600">This board. The phone is connected to it.</p>
          </section>

          <button
            type="button"
            className="h-11 border border-neutral-300 bg-white"
            onClick={() => void app.leave()}
          >
            Disconnect
          </button>
        </div>
      )}
    </main>
  );
}

function FollowerCard({
  follower,
  leaderFix,
  leaderLat,
  leaderLon,
  heading,
}: {
  follower: TrackedFollower;
  leaderFix: boolean | null;
  leaderLat: number | null;
  leaderLon: number | null;
  heading: number | null;
}) {
  const followerLat = follower.lat;
  const followerLon = follower.lon;
  const ready =
    leaderFix === true &&
    follower.fix === true &&
    leaderLat != null &&
    leaderLon != null &&
    followerLat != null &&
    followerLon != null;
  const bearing = ready ? bearingDegrees(leaderLat, leaderLon, followerLat, followerLon) : null;
  const arrow = bearing == null ? null : heading == null ? bearing : relativeBearing(bearing, heading);
  const label = boardLabel(follower.id);

  return (
    <article className={`border px-3 py-3 ${follower.outOfRange ? "border-red-700" : "border-neutral-200"}`}>
      <h3 className="text-sm font-medium">{label}</h3>
      <p className="mt-2 text-3xl tabular-nums">
        {follower.separationKnown === true
          ? formatSeparation(follower.separationM)
          : follower.separationKnown === false
            ? "No fix"
            : "—"}
      </p>
      {arrow == null || bearing == null ? (
        <p className="mt-2 text-sm text-neutral-600">Waiting for a fix on this board and the leader.</p>
      ) : (
        <div className="mt-3">
          <div className="flex h-24 w-24 items-center justify-center rounded-full border border-neutral-300">
            <div style={{ transform: `rotate(${arrow}deg)` }}>
              <div className="h-0 w-0 border-x-[10px] border-b-[40px] border-x-transparent border-b-black" />
            </div>
          </div>
          <p className="mt-2 text-lg">{heading == null ? cardinalLabel(bearing) : guideCue(arrow)}</p>
          <p className="mt-1 text-sm text-neutral-600">
            {heading == null
              ? `North is up. ${label} is ${cardinalLabel(bearing)}.`
              : "Point the top of the phone along the arrow."}
          </p>
        </div>
      )}
      {follower.fix === true ? (
        <p className="mt-2 text-sm tabular-nums text-neutral-600">
          {formatGpsDegrees(follower.lat)}, {formatGpsDegrees(follower.lon)}
        </p>
      ) : (
        <p className="mt-2 text-sm text-neutral-600">{follower.fix === false ? "No GPS fix" : "No position yet"}</p>
      )}
    </article>
  );
}
