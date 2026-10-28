"use client";

import { useEffect, useRef, useState } from "react";
import { BROADCAST_ID, THRESHOLD_MAX_M, THRESHOLD_MIN_M } from "@/lib/ble/constants";
import { isNativeShell } from "@/lib/ble/create-transport";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { bearingDegrees, cardinalLabel, guideCue, relativeBearing } from "@/lib/geo";
import { formatGpsDegrees, formatSeparation } from "@/lib/format";
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
  const wasOut = useRef(false);

  useEffect(() => {
    const native = isNativeShell();
    setNativeShell(native);
    setBle(native || webBluetoothAvailable());
  }, []);

  useEffect(() => {
    setRangeDraft(String(state.thresholdMeters));
  }, [state.thresholdMeters]);

  useEffect(() => {
    const out = state.outOfRange;
    if (out && !wasOut.current && state.separationM != null) {
      void notifyOutOfRange(state.separationM, state.thresholdMeters);
    }
    wasOut.current = out;
  }, [state.outOfRange, state.separationM, state.thresholdMeters]);

  const checkInLabel = state.groupOkAt
    ? "They're OK"
    : state.groupCheckInAt
      ? "Waiting for OK"
      : "Not sent";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
      <h1 className="text-xl font-semibold">Excursion</h1>

      {!onLink ? (
        <div className="mt-6 flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Connect to the LoRa leader ({BLE_NAME_PREFIX}). Distance and direction come from the GPS on the leader and the follower.
          </p>
          {state.error && (
            <p className="text-sm text-red-700" role="alert">
              {state.error}
            </p>
          )}
          <button
            type="button"
            className="h-11 border border-black bg-black text-white disabled:opacity-40"
            disabled={ble === false || app.busy}
            onClick={() => void app.connectBeacon(false)}
          >
            {app.busy ? "Connecting" : "Connect"}
          </button>
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
          {state.outOfRange && (
            <p className="border border-red-700 bg-red-50 px-3 py-3 text-sm text-red-800" role="alert">
              Follower is out of range
              {state.separationM != null ? ` · ${formatSeparation(state.separationM)}` : ""}. Limit{" "}
              {state.thresholdMeters} m.
            </p>
          )}
          <p className="text-sm text-neutral-600">
            {state.connection === "connected"
              ? "Connected"
              : state.connection === "reconnecting"
                ? "Reconnecting"
                : state.connection === "scanning"
                  ? "Connecting"
                  : "Disconnected"}
            {state.deviceName ? ` · ${state.deviceName}` : ""}
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
              Writes the leader radio. The follower sends OK back over LoRa, then this line updates.
            </p>
            {state.liveLink?.counter != null && (
              <p className="mt-2 text-sm text-neutral-500">Link counter {state.liveLink.counter}</p>
            )}
          </section>

          <DirectionGuide
            leaderFix={state.gpsFix}
            leaderLat={state.gpsLat}
            leaderLon={state.gpsLon}
            followerFix={state.followerFix}
            followerLat={state.followerLat}
            followerLon={state.followerLon}
            heading={compass.heading}
            needsGesture={compass.needsGesture}
            denied={compass.denied}
            onEnable={() => void compass.enable()}
          />

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">Distance</h2>
            <p className="mt-2 text-4xl tabular-nums">
              {state.separationKnown === true
                ? formatSeparation(state.separationM)
                : state.separationKnown === false
                  ? "No fix"
                  : "—"}
            </p>
            <p className="mt-2 text-sm text-neutral-600">
              Leader to follower. Both GPS antennas need a view of the sky.
            </p>
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
              Whole meters, from {THRESHOLD_MIN_M} to {THRESHOLD_MAX_M}. Past this, the follower light
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
            <p className="mt-2 text-sm text-neutral-600">Leader position.</p>
            <h3 className="mt-4 text-sm font-medium">Follower GPS</h3>
            {state.followerFix === true ? (
              <div className="mt-2">
                <p className="text-sm text-neutral-600">Latitude</p>
                <p className="text-2xl tabular-nums">{formatGpsDegrees(state.followerLat)}</p>
                <p className="mt-2 text-sm text-neutral-600">Longitude</p>
                <p className="text-2xl tabular-nums">{formatGpsDegrees(state.followerLon)}</p>
              </div>
            ) : (
              <p className="mt-2 text-4xl">{state.followerFix === false ? "No fix" : "—"}</p>
            )}
            <p className="mt-2 text-sm text-neutral-600">Sent from the follower over LoRa.</p>
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

function DirectionGuide({
  leaderFix,
  leaderLat,
  leaderLon,
  followerFix,
  followerLat,
  followerLon,
  heading,
  needsGesture,
  denied,
  onEnable,
}: {
  leaderFix: boolean | null;
  leaderLat: number | null;
  leaderLon: number | null;
  followerFix: boolean | null;
  followerLat: number | null;
  followerLon: number | null;
  heading: number | null;
  needsGesture: boolean;
  denied: boolean;
  onEnable: () => void;
}) {
  const ready =
    leaderFix === true &&
    followerFix === true &&
    leaderLat != null &&
    leaderLon != null &&
    followerLat != null &&
    followerLon != null;
  const bearing = ready ? bearingDegrees(leaderLat, leaderLon, followerLat, followerLon) : null;
  const arrow = bearing == null ? null : heading == null ? bearing : relativeBearing(bearing, heading);

  return (
    <section className="border-t border-neutral-200 pt-6">
      <h2 className="text-sm font-medium">Direction</h2>
      {arrow == null || bearing == null ? (
        <p className="mt-2 text-4xl">—</p>
      ) : (
        <div className="mt-4">
          <div className="mx-auto flex h-36 w-36 items-center justify-center rounded-full border border-neutral-300">
            <div style={{ transform: `rotate(${arrow}deg)` }}>
              <div className="h-0 w-0 border-x-[14px] border-b-[56px] border-x-transparent border-b-black" />
            </div>
          </div>
          <p className="mt-3 text-2xl">{heading == null ? cardinalLabel(bearing) : guideCue(arrow)}</p>
          <p className="mt-1 text-sm text-neutral-600">
            {heading == null
              ? `North is up. Follower is ${cardinalLabel(bearing)}.`
              : "Point the top of the phone along the arrow."}
          </p>
        </div>
      )}
      <p className="mt-2 text-sm text-neutral-600">
        {ready
          ? "Bearing from the leader GPS to the follower GPS."
          : "Waiting for a fix on both the leader and the follower."}
      </p>
      {(needsGesture || heading == null) && (
        <button
          type="button"
          className="mt-3 h-11 w-full border border-black bg-white"
          onClick={onEnable}
        >
          Use compass
        </button>
      )}
      {denied && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          Compass permission was denied. The arrow stays aligned to north.
        </p>
      )}
    </section>
  );
}
