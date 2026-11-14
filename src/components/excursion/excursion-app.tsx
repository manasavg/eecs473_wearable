"use client";

import { useEffect, useRef, useState } from "react";
import {
  BROADCAST_ID,
  SILENCE_MAX_S,
  SILENCE_MIN_S,
  THRESHOLD_MAX_M,
  THRESHOLD_MIN_M,
} from "@/lib/ble/constants";
import type { CheckInStatus, LastKnown, TrackedFollower } from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { bearingDegrees, cardinalLabel, guideCue, haversineMeters, relativeBearing } from "@/lib/geo";
import { boardLabel, formatGpsDegrees, formatSeparation } from "@/lib/format";
import {
  ensureNotifyPermission,
  formatDuration,
  notifyNoAnswer,
  notifyOutOfRange,
  notifySilent,
} from "@/lib/notify";
import { BoardSetup } from "./board-setup";
import { useCompass } from "./use-compass";
import { useExcursion } from "./use-excursion";

function followerLabel(follower: TrackedFollower): string {
  return follower.name || boardLabel(follower.id);
}

/** Re-render every few seconds so "heard 40 s ago" stays current. */
function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ago(at: number | null, now: number): string {
  if (at == null) return "never";
  return `${formatDuration((now - at) / 1000)} ago`;
}

/** "3:42:10 PM" today, "Nov 13, 3:42 PM" on another day. */
function clockTime(at: number, now: number): string {
  const when = new Date(at);
  if (when.toDateString() === new Date(now).toDateString()) {
    return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  return when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function lastKnownSummary(known: LastKnown, now: number): string {
  return `last known ${formatGpsDegrees(known.lat)}, ${formatGpsDegrees(known.lon)} at ${clockTime(known.at, now)}`;
}

export function ExcursionApp() {
  const app = useExcursion();
  const { state } = app;
  const compass = useCompass();
  const now = useNow();
  const linked = state.connection === "connected";
  const onLink = state.mode !== "idle";
  const [ble, setBle] = useState<boolean | null>(null);
  const [nativeShell, setNativeShell] = useState(false);
  const [rangeDraft, setRangeDraft] = useState(String(state.thresholdMeters));
  const [silenceDraft, setSilenceDraft] = useState(String(state.silenceSeconds));
  const [confirmDraft, setConfirmDraft] = useState(state.requireConfirm);
  const [looked, setLooked] = useState(false);
  const seen = useRef<Record<number, { out: boolean; silent: boolean; checkIn: CheckInStatus | null }>>({});

  useEffect(() => {
    const native = isNativeShell();
    setNativeShell(native);
    setBle(native || webBluetoothAvailable());
  }, []);

  useEffect(() => {
    setRangeDraft(String(state.thresholdMeters));
  }, [state.thresholdMeters]);

  useEffect(() => {
    setSilenceDraft(String(state.silenceSeconds));
  }, [state.silenceSeconds]);

  useEffect(() => {
    setConfirmDraft(state.requireConfirm);
  }, [state.requireConfirm]);

  // Notify once each time a follower goes out of range, goes silent, or misses a check-in.
  useEffect(() => {
    const next: typeof seen.current = {};
    for (const follower of state.followers) {
      const previous = seen.current[follower.id];
      const who = followerLabel(follower);
      const checkIn = follower.checkIn?.status ?? null;
      if (previous) {
        if (follower.outOfRange && !previous.out && follower.separationM != null) {
          void notifyOutOfRange(follower.separationM, state.thresholdMeters, who);
        }
        if (follower.silent && !previous.silent) {
          void notifySilent(
            who,
            state.silenceSeconds,
            follower.lastKnown ? lastKnownSummary(follower.lastKnown, Date.now()) : null,
          );
        }
        if (
          (checkIn === "noAnswer" || checkIn === "failed" || checkIn === "unconfirmed") &&
          previous.checkIn !== checkIn
        ) {
          void notifyNoAnswer(who, follower.checkIn?.reason ?? "No answer");
        }
      }
      // A board first seen while already silent does not page. Its card still shows it.
      next[follower.id] = { out: follower.outOfRange, silent: follower.silent, checkIn };
    }
    seen.current = next;
  }, [state.followers, state.thresholdMeters, state.silenceSeconds]);

  const followers = state.followers;
  const outFollowers = followers.filter((follower) => follower.outOfRange && !follower.silent);
  const silentFollowers = followers.filter((follower) => follower.silent);
  const asked = followers.filter((follower) => follower.checkIn);
  const answered = asked.filter((follower) => follower.checkIn?.status === "ok");
  const missed = asked.filter(
    (follower) =>
      follower.checkIn?.status === "noAnswer" ||
      follower.checkIn?.status === "failed" ||
      follower.checkIn?.status === "unconfirmed",
  );
  const received = asked.filter((follower) => follower.checkIn?.status === "received");
  const checkInSummary =
    asked.length === 0
      ? "Not sent"
      : answered.length === asked.length
        ? asked.length === 1
          ? `${followerLabel(answered[0])} is OK`
          : `All ${asked.length} OK`
        : missed.length > 0
          ? `${answered.length} of ${asked.length} OK · ${missed.length} not OK`
          : received.length > 0
            ? `${answered.length} of ${asked.length} OK · waiting for OK press`
            : `${answered.length} of ${asked.length} OK · waiting`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
      <h1 className="text-xl font-semibold">Excursion</h1>

      {!onLink ? (
        <div className="mt-6 flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Meshtastic boards on the same channel. Pick any one. That board is the leader, and it reports
            every other board it hears. Disconnect and pick a different board to swap.
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
                  void ensureNotifyPermission();
                  void app.lookForDevices();
                }}
              >
                {app.scanning ? "Looking" : "Find devices"}
              </button>
              {app.scanning && app.peers.length === 0 && (
                <p className="text-sm text-neutral-600">Looking for Meshtastic boards…</p>
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
                  No Meshtastic boards in range. Power the boards on, then look again.
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              className="h-11 border border-black bg-black text-white disabled:opacity-40"
              disabled={ble === false || app.busy}
              onClick={() => {
                void ensureNotifyPermission();
                void app.connectBeacon(false);
              }}
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
          {(silentFollowers.length > 0 || outFollowers.length > 0) && (
            <div className="border border-red-700 bg-red-50 px-3 py-3 text-sm text-red-800" role="alert">
              {silentFollowers.map((follower) => (
                <p key={`silent-${follower.id}`}>
                  Lost contact with {followerLabel(follower)} · last heard {ago(follower.lastHeardAt, now)}
                  {follower.lastKnown ? ` · ${lastKnownSummary(follower.lastKnown, now)}` : ""}.
                </p>
              ))}
              {outFollowers.map((follower) => (
                <p key={`out-${follower.id}`}>
                  {followerLabel(follower)} is out of range
                  {follower.separationM != null ? ` · ${formatSeparation(follower.separationM)}` : ""}. Limit{" "}
                  {state.thresholdMeters} m
                  {follower.lastKnown ? ` · ${lastKnownSummary(follower.lastKnown, now)}` : ""}.
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
          {state.error && (
            <p className="text-sm text-red-700" role="alert">
              {state.error}{" "}
              <button type="button" className="underline" onClick={app.dismissError}>
                Dismiss
              </button>
            </p>
          )}

          <section>
            <h2 className="text-sm font-medium">Check-in</h2>
            <p className="mt-2 text-2xl">{checkInSummary}</p>
            <button
              type="button"
              className="mt-3 h-11 w-full border border-black bg-black text-white disabled:opacity-40"
              disabled={!linked || followers.length === 0}
              onClick={() => void app.checkIn(BROADCAST_ID)}
            >
              {followers.length > 1 ? `Check in all ${followers.length}` : "Check in"}
            </button>
            <p className="mt-2 text-sm text-neutral-600">
              Sends CHECK IN to each follower. To ask one board, use the button on its card.{" "}
              {state.requireConfirm
                ? "A board shows Received when its radio gets the message, and OK once someone presses its OK button."
                : "A board shows OK when its radio gets the message, or when someone presses its OK button."}
            </p>
          </section>

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">
              Followers{followers.length > 0 ? ` (${followers.length})` : ""}
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              {followers.length === 0
                ? "Waiting for the other boards. They show up when this radio hears them. Nodes from the public internet are left out."
                : "Every board this radio has heard. GPS antennas need a view of the sky."}
            </p>
            {followers.length > 0 && (compass.needsGesture || compass.heading == null) && (
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
              {followers.map((follower) => (
                <FollowerCard
                  key={follower.id}
                  follower={follower}
                  now={now}
                  linked={linked}
                  onCheckIn={() => void app.checkIn(follower.id)}
                  leaderFix={state.gpsFix}
                  leaderLat={state.gpsLat}
                  leaderLon={state.gpsLon}
                  heading={compass.heading}
                />
              ))}
            </div>
          </section>

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">Alerts</h2>
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const meters = Number.parseInt(rangeDraft, 10);
                const seconds = Number.parseInt(silenceDraft, 10);
                if (!Number.isFinite(meters) || !Number.isFinite(seconds)) return;
                void ensureNotifyPermission();
                app.saveLimits(meters, seconds, confirmDraft);
              }}
            >
              <label className="flex items-center gap-2">
                <span className="w-32 text-sm text-neutral-600">Out of range past</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={THRESHOLD_MIN_M}
                  max={THRESHOLD_MAX_M}
                  step={1}
                  value={rangeDraft}
                  className="h-11 w-24 border border-neutral-300 px-3 tabular-nums"
                  onChange={(event) => setRangeDraft(event.target.value)}
                />
                <span className="text-sm text-neutral-600">m</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="w-32 text-sm text-neutral-600">Lost contact after</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={SILENCE_MIN_S}
                  max={SILENCE_MAX_S}
                  step={1}
                  value={silenceDraft}
                  className="h-11 w-24 border border-neutral-300 px-3 tabular-nums"
                  onChange={(event) => setSilenceDraft(event.target.value)}
                />
                <span className="text-sm text-neutral-600">s</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={confirmDraft}
                  onChange={(event) => setConfirmDraft(event.target.checked)}
                />
                <span className="text-sm text-neutral-600">Check-in needs an OK button press on the board</span>
              </label>
              <button type="submit" className="h-11 border border-black bg-black px-4 text-white">
                Save
              </button>
            </form>
            <p className="mt-2 text-sm text-neutral-600">
              Range {THRESHOLD_MIN_M}–{THRESHOLD_MAX_M} m. Lost contact {SILENCE_MIN_S}–{SILENCE_MAX_S} s. Set
              each board to send its position more often than the lost-contact time, or it will be flagged
              between reports. Both are saved on this phone.
            </p>
          </section>

          <BoardSetup
            board={state.board}
            setup={state.boardSetup}
            linked={linked}
            onSetUp={app.setUpBoard}
          />

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">Leader GPS</h2>
            {state.gpsFix === true ? (
              <div className="mt-2">
                <p className="text-sm text-neutral-600">Latitude</p>
                <p className="text-2xl tabular-nums">{formatGpsDegrees(state.gpsLat)}</p>
                <p className="mt-2 text-sm text-neutral-600">Longitude</p>
                <p className="text-2xl tabular-nums">{formatGpsDegrees(state.gpsLon)}</p>
                {state.gpsAt != null && (
                  <p className="mt-2 text-sm text-neutral-600">Position from {ago(state.gpsAt, now)}</p>
                )}
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

function checkInText(follower: TrackedFollower, now: number): string {
  const checkIn = follower.checkIn;
  if (!checkIn) return "Not checked in";
  switch (checkIn.status) {
    case "sending":
      return "Sending…";
    case "waiting":
      return `Waiting · sent ${ago(checkIn.sentAt, now)}`;
    case "received":
      return `Received · waiting for OK press`;
    case "ok":
      return checkIn.confirmedBy === "person"
        ? `OK · pressed ${ago(checkIn.answeredAt, now)}`
        : `OK · received ${ago(checkIn.answeredAt, now)}`;
    case "unconfirmed":
      return `No OK pressed · received ${ago(checkIn.receivedAt, now)}`;
    case "noAnswer":
      return `No answer · sent ${ago(checkIn.sentAt, now)}`;
    case "failed":
      return `Not delivered · ${checkIn.reason ?? "unknown error"}`;
  }
}

function FollowerCard({
  follower,
  now,
  linked,
  onCheckIn,
  leaderFix,
  leaderLat,
  leaderLon,
  heading,
}: {
  follower: TrackedFollower;
  now: number;
  linked: boolean;
  onCheckIn: () => void;
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
  const label = followerLabel(follower);
  const alarm = follower.outOfRange || follower.silent;
  const status = follower.checkIn?.status;
  const busy = status === "sending" || status === "waiting" || status === "received";

  return (
    <article className={`border px-3 py-3 ${alarm ? "border-red-700" : "border-neutral-200"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <p className={`text-sm ${follower.silent ? "text-red-700" : "text-neutral-600"}`}>
          {follower.silent ? "Lost contact · " : ""}heard {ago(follower.lastHeardAt, now)}
        </p>
      </div>
      <p className={`mt-2 text-3xl tabular-nums ${follower.silent ? "text-neutral-400" : ""}`}>
        {follower.separationKnown === true
          ? formatSeparation(follower.separationM)
          : follower.separationKnown === false
            ? "No fix"
            : "—"}
      </p>
      {follower.silent && follower.separationKnown === true && (
        <p className="text-sm text-neutral-600">Last known distance. The board may have moved.</p>
      )}
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
          {follower.positionAt != null ? ` · ${ago(follower.positionAt, now)}` : ""}
        </p>
      ) : (
        <p className="mt-2 text-sm text-neutral-600">{follower.fix === false ? "No GPS fix" : "No position yet"}</p>
      )}
      {follower.lastKnown && (alarm || follower.fix !== true) && (
        <LastKnownBlock
          known={follower.lastKnown}
          label={label}
          now={now}
          leaderFix={leaderFix}
          leaderLat={leaderLat}
          leaderLon={leaderLon}
        />
      )}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-neutral-200 pt-3">
        <p
          className={`text-sm ${
            status === "ok"
              ? "text-green-700"
              : status === "noAnswer" || status === "failed" || status === "unconfirmed"
                ? "text-red-700"
                : status === "received"
                  ? "text-amber-700"
                : "text-neutral-600"
          }`}
        >
          {checkInText(follower, now)}
        </p>
        <button
          type="button"
          className="h-10 shrink-0 border border-black bg-white px-3 text-sm disabled:opacity-40"
          disabled={!linked || busy}
          onClick={onCheckIn}
        >
          Check in
        </button>
      </div>
    </article>
  );
}

function LastKnownBlock({
  known,
  label,
  now,
  leaderFix,
  leaderLat,
  leaderLon,
}: {
  known: LastKnown;
  label: string;
  now: number;
  leaderFix: boolean | null;
  leaderLat: number | null;
  leaderLon: number | null;
}) {
  const fromHere =
    leaderFix === true && leaderLat != null && leaderLon != null
      ? {
          meters: haversineMeters(leaderLat, leaderLon, known.lat, known.lon),
          bearing: bearingDegrees(leaderLat, leaderLon, known.lat, known.lon),
        }
      : null;
  const maps = `https://maps.apple.com/?ll=${known.lat},${known.lon}&q=${encodeURIComponent(
    `${label} last known`,
  )}`;
  return (
    <div className="mt-3 border border-amber-600 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="font-medium">Last known location</p>
      <p className="mt-1 tabular-nums">
        {formatGpsDegrees(known.lat)}, {formatGpsDegrees(known.lon)}
      </p>
      <p className="mt-1">
        {clockTime(known.at, now)} · {ago(known.at, now)}
      </p>
      {fromHere && (
        <p className="mt-1">
          {formatSeparation(fromHere.meters)} {cardinalLabel(fromHere.bearing)} of the leader now
        </p>
      )}
      <a className="mt-1 inline-block underline" href={maps} target="_blank" rel="noreferrer">
        Open in Maps
      </a>
    </div>
  );
}
