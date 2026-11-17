"use client";

import { useEffect, useRef, useState } from "react";
import {
  BROADCAST_ID,
  SILENCE_MAX_S,
  SILENCE_MIN_S,
  THRESHOLD_MAX_M,
  THRESHOLD_MIN_M,
} from "@/lib/ble/constants";
import {
  isInGroup,
  nodeSuffix,
  peerSuffix,
  type CheckInStatus,
  type GroupMember,
  type LastKnown,
  type TrackedFollower,
} from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { bearingDegrees, cardinalLabel, guideCue, haversineMeters, relativeBearing } from "@/lib/geo";
import { boardLabel, formatGpsDegrees, formatSeparation } from "@/lib/format";
import {
  ensureNotifyPermission,
  formatDuration,
  notifyEmergency,
  notifyLinkLost,
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
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  /** The name chosen in the app, else the radio's name, else the node number. */
  const nameOf = (id: number, fallback: string | null) => app.names[nodeSuffix(id)] || fallback || boardLabel(id);
  const label = (follower: TrackedFollower) => nameOf(follower.id, follower.name);
  const leaderLabel =
    state.leaderId != null ? nameOf(state.leaderId, state.deviceName) : (state.deviceName ?? "the leader");
  const lastConnection = useRef(state.connection);
  const announced = useRef<Record<number, number>>({});
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

  // One notification for each new emergency.
  useEffect(() => {
    const next: Record<number, number> = {};
    for (const emergency of state.emergencies) {
      next[emergency.id] = emergency.at;
      if (announced.current[emergency.id] === emergency.at) continue;
      const where = emergency.lastKnown
        ? ` Last known ${formatGpsDegrees(emergency.lastKnown.lat)}, ${formatGpsDegrees(emergency.lastKnown.lon)}.`
        : "";
      void notifyEmergency(app.names[nodeSuffix(emergency.id)] || emergency.name, `${emergency.text}${where}`);
    }
    announced.current = next;
  }, [state.emergencies, app.names]);

  // The phone lost the leader and gave up reconnecting: every other alert stops with it.
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = state.connection;
    if (
      state.connection === "disconnected" &&
      state.mode !== "idle" &&
      (previous === "connected" || previous === "reconnecting")
    ) {
      void notifyLinkLost(state.deviceName);
    }
  }, [state.connection, state.mode, state.deviceName]);

  // Notify once each time a follower goes out of range, goes silent, or misses a check-in.
  useEffect(() => {
    const next: typeof seen.current = {};
    const group = { group: state.group };
    for (const follower of state.followers.filter((item) => isInGroup(group, item.id))) {
      const previous = seen.current[follower.id];
      const who = app.names[nodeSuffix(follower.id)] || followerLabel(follower);
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
  }, [state.followers, state.group, state.thresholdMeters, state.silenceSeconds, app.names]);

  const grouped = state.group.length > 0;
  const followers = state.followers.filter((follower) => isInGroup(state, follower.id));
  const others = grouped ? state.followers.filter((follower) => !isInGroup(state, follower.id)) : [];
  const leaderInGroup = state.leaderId == null || isInGroup(state, state.leaderId);
  const addToGroup = (items: Array<{ id: number; name: string }>) => {
    const added: GroupMember[] = items.map((item) => ({ suffix: nodeSuffix(item.id), name: item.name }));
    app.setGroup([...state.group, ...added.filter((item) => !state.group.some((member) => member.suffix === item.suffix))]);
  };
  const groupHas = (suffix: string | null) => suffix != null && state.group.some((member) => member.suffix === suffix);
  const toggleGroup = (suffix: string, name: string) =>
    app.setGroup(
      groupHas(suffix)
        ? state.group.filter((member) => member.suffix !== suffix)
        : [...state.group, { suffix, name }],
    );
  // Saved members the scan has not found, so they can still be unticked.
  const unseenMembers = state.group.filter(
    (member) => !app.peers.some((peer) => peerSuffix(peer.name) === member.suffix),
  );
  // Every board for Boards & names: the leader, then each board heard or in the group.
  const allBoards = [
    ...(state.leaderId != null
      ? [
          {
            id: state.leaderId,
            suffix: nodeSuffix(state.leaderId),
            radioName: state.deviceName,
            label: leaderLabel,
            leader: true,
            placeholder: false,
          },
        ]
      : []),
    ...state.followers.map((follower) => ({
      id: follower.id,
      suffix: nodeSuffix(follower.id),
      radioName: follower.placeholder ? null : follower.name,
      label: label(follower),
      leader: false,
      placeholder: follower.placeholder,
    })),
  ];
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
          ? `${label(answered[0])} is OK`
          : `All ${asked.length} OK`
        : missed.length > 0
          ? `${answered.length} of ${asked.length} OK · ${missed.length} not OK`
          : received.length > 0
            ? `${answered.length} of ${asked.length} OK · waiting for OK press`
            : `${answered.length} of ${asked.length} OK · waiting`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{view === "settings" && onLink ? "Settings" : "Excursion"}</h1>
        {onLink && (
          <button
            type="button"
            className="h-10 border border-neutral-300 bg-white px-3 text-sm"
            onClick={() => setView(view === "settings" ? "dashboard" : "settings")}
          >
            {view === "settings" ? "Done" : "Settings"}
          </button>
        )}
      </header>

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
              {(app.peers.length > 0 || state.group.length > 0) && (
                <>
                  <p className="text-sm text-neutral-600">
                    Tick every board in your group, the leader too. Boards not ticked are hidden once you connect.
                    Then tap Make leader on the board to connect to.
                  </p>
                  <ul className="flex flex-col gap-2">
                    {app.peers.map((peer) => {
                      const suffix = peerSuffix(peer.name);
                      return (
                        <li key={peer.deviceId} className="flex h-14 items-stretch border border-neutral-300 bg-white">
                          <label className="flex flex-1 items-center gap-3 px-3">
                            <input
                              type="checkbox"
                              className="h-5 w-5"
                              disabled={suffix == null}
                              checked={groupHas(suffix)}
                              onChange={() => suffix && toggleGroup(suffix, peer.name)}
                              aria-label={`${peer.name} is in the group`}
                            />
                            <span className="flex flex-col">
                              <span className="font-medium">{(suffix && app.names[suffix]) || peer.name}</span>
                              {suffix && app.names[suffix] && (
                                <span className="text-xs text-neutral-500">{peer.name}</span>
                              )}
                            </span>
                          </label>
                          <button
                            type="button"
                            className="border-l border-neutral-300 px-3 text-sm text-neutral-700 disabled:opacity-40"
                            disabled={app.busy}
                            onClick={() => {
                              if (suffix && state.group.length > 0 && !groupHas(suffix)) {
                                toggleGroup(suffix, peer.name);
                              }
                              void app.connectPeer(peer);
                            }}
                          >
                            {app.busy ? "Connecting" : "Make leader"}
                          </button>
                        </li>
                      );
                    })}
                    {unseenMembers.map((member) => (
                      <li key={member.suffix} className="flex h-14 items-center border border-dashed border-neutral-300 px-3">
                        <label className="flex flex-1 items-center gap-3">
                          <input
                            type="checkbox"
                            className="h-5 w-5"
                            checked
                            onChange={() => toggleGroup(member.suffix, member.name)}
                            aria-label={`${member.name} is in the group`}
                          />
                          <span>{member.name}</span>
                        </label>
                        <span className="text-sm text-neutral-500">{app.scanning ? "looking" : "not found"}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-sm text-neutral-600">
                    {state.group.length === 0
                      ? "No group yet: every board heard will show."
                      : `Group: ${state.group.length} board${state.group.length === 1 ? "" : "s"}.`}
                  </p>
                </>
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
      ) : view === "settings" ? (
        <div className="mt-6 flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Boards &amp; names</h2>
            <p className="text-sm text-neutral-600">
              Name each board here; the name shows everywhere in the app. Tick the boards in your group. Once any
              board is ticked, unticked boards are hidden from the dashboard.
            </p>
            {allBoards.length === 0 && <p className="text-sm text-neutral-600">No boards heard yet.</p>}
            <ul className="flex flex-col gap-2">
              {allBoards.map((item) => (
                <li key={item.suffix} className="border border-neutral-300 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0"
                      checked={groupHas(item.suffix)}
                      onChange={() => toggleGroup(item.suffix, item.radioName ?? boardLabel(item.id))}
                      aria-label={`${item.label} is in the group`}
                    />
                    <input
                      type="text"
                      defaultValue={app.names[item.suffix] ?? ""}
                      placeholder={item.radioName ?? boardLabel(item.id)}
                      maxLength={30}
                      className="h-10 min-w-0 flex-1 border border-neutral-300 px-2"
                      aria-label={`Name for ${item.label}`}
                      onBlur={(event) => app.renameBoard(item.suffix, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                      }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-neutral-500 tabular-nums">
                    {item.leader ? "Leader · " : ""}ID {item.placeholder ? `…${item.suffix}` : `!${(item.id >>> 0).toString(16).padStart(8, "0")}`}
                    {item.radioName ? ` · radio name ${item.radioName}` : ""}
                    {item.placeholder ? " · not heard yet" : ""}
                  </p>
                </li>
              ))}
            </ul>
            {!grouped && allBoards.length > 0 && (
              <button
                type="button"
                className="h-11 border border-black bg-white"
                onClick={() =>
                  app.setGroup(allBoards.map((item) => ({ suffix: item.suffix, name: item.radioName ?? boardLabel(item.id) })))
                }
              >
                Tick all {allBoards.length}
              </button>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Alerts</h2>
            <form
              className="flex flex-col gap-3"
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
            <p className="text-sm text-neutral-600">
              Range {THRESHOLD_MIN_M}–{THRESHOLD_MAX_M} m. Lost contact {SILENCE_MIN_S}–{SILENCE_MAX_S} s. Saved on this
              phone.
            </p>
          </section>

          <BoardSetup
            board={state.board}
            setup={state.boardSetup}
            linked={linked}
            leaderLabel={leaderLabel}
            onSetUp={app.setUpBoard}
            native={nativeShell}
            others={app.peers
              .filter((peer) => {
                const suffix = peerSuffix(peer.name);
                return !(state.leaderId != null && suffix === nodeSuffix(state.leaderId)) && peer.name !== state.deviceName;
              })
              .map((peer) => {
                const suffix = peerSuffix(peer.name);
                return { peer, label: (suffix && app.names[suffix]) || peer.name };
              })}
            scanning={app.scanning}
            onScan={() => void app.lookForDevices()}
            onSetUpOther={app.setUpOther}
            otherSetup={app.otherSetup}
          />

          <button
            type="button"
            className="h-11 border border-neutral-300 bg-white"
            onClick={() => {
              setView("dashboard");
              void app.leave();
            }}
          >
            Disconnect from {leaderLabel}
          </button>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {state.emergencies.map((emergency) => {
            const who = nameOf(emergency.id, emergency.name);
            return (
              <div
                key={`emergency-${emergency.id}`}
                className="border-4 border-red-800 bg-red-700 px-3 py-3 text-white"
                role="alert"
                aria-live="assertive"
              >
                <p className="text-lg font-bold">EMERGENCY · {who}</p>
                <p className="mt-1 text-sm">
                  {emergency.how === "hold" ? "Held their button. " : `Sent "${emergency.text}". `}
                  {clockTime(emergency.at, now)} · {ago(emergency.at, now)}
                </p>
                {emergency.lastKnown && (
                  <p className="mt-1 text-sm tabular-nums">
                    Last known {formatGpsDegrees(emergency.lastKnown.lat)}, {formatGpsDegrees(emergency.lastKnown.lon)}{" "}
                    at {clockTime(emergency.lastKnown.at, now)} ·{" "}
                    <a
                      className="underline"
                      href={`https://maps.apple.com/?ll=${emergency.lastKnown.lat},${emergency.lastKnown.lon}&q=${encodeURIComponent(who)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Maps
                    </a>
                  </p>
                )}
                <button
                  type="button"
                  className="mt-3 h-11 w-full border border-white bg-white font-medium text-red-800"
                  onClick={() => app.acknowledgeEmergency(emergency.id)}
                >
                  Acknowledge
                </button>
              </div>
            );
          })}
          {(silentFollowers.length > 0 || outFollowers.length > 0) && (
            <div className="border border-red-700 bg-red-50 px-3 py-3 text-sm text-red-800" role="alert">
              {silentFollowers.map((follower) => (
                <p key={`silent-${follower.id}`}>
                  Lost contact with {label(follower)} · last heard {ago(follower.lastHeardAt, now)}
                  {follower.lastKnown ? ` · ${lastKnownSummary(follower.lastKnown, now)}` : ""}.
                </p>
              ))}
              {outFollowers.map((follower) => (
                <p key={`out-${follower.id}`}>
                  {label(follower)} is out of range
                  {follower.separationM != null ? ` · ${formatSeparation(follower.separationM)}` : ""}. Limit{" "}
                  {state.thresholdMeters} m
                  {follower.lastKnown ? ` · ${lastKnownSummary(follower.lastKnown, now)}` : ""}.
                </p>
              ))}
            </div>
          )}
          {(state.board?.region === 0 || state.board?.txEnabled === false) && (
            <div className="border border-red-700 bg-red-50 px-3 py-3 text-sm text-red-800" role="alert">
              {state.board?.region === 0
                ? "The leader's LoRa region is not set, so its radio is off and it cannot hear the other boards."
                : "The leader's transmit is turned off, so the other boards cannot hear it."}{" "}
              <button type="button" className="underline" onClick={() => setView("settings")}>
                Open Board setup
              </button>
            </div>
          )}
          {state.error && (
            <p className="text-sm text-red-700" role="alert">
              {state.error}{" "}
              <button type="button" className="underline" onClick={app.dismissError}>
                Dismiss
              </button>
            </p>
          )}

          <section className="border border-neutral-200 px-3 py-2 text-sm text-neutral-700">
            <p>
              <span className="font-medium">
                {state.connection === "connected"
                  ? "Leader"
                  : state.connection === "reconnecting"
                    ? "Reconnecting to"
                    : state.connection === "scanning"
                      ? "Connecting to"
                      : "Disconnected from"}
              </span>{" "}
              {leaderLabel}
              {batteryText(state.leaderBatteryPercent) ? ` · Battery ${batteryText(state.leaderBatteryPercent)}` : ""}
            </p>
            <p className="tabular-nums text-neutral-600">
              {state.gpsFix === true
                ? `GPS ${formatGpsDegrees(state.gpsLat)}, ${formatGpsDegrees(state.gpsLon)}${
                    state.gpsAt != null ? ` · ${ago(state.gpsAt, now)}` : ""
                  }`
                : state.gpsFix === false
                  ? "GPS: no fix"
                  : "GPS: waiting"}
            </p>
            {grouped && !leaderInGroup && state.leaderId != null && (
              <p className="mt-1 text-neutral-600">
                This board is not in the group.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => addToGroup([{ id: state.leaderId!, name: state.deviceName ?? boardLabel(state.leaderId!) }])}
                >
                  Add it
                </button>
              </p>
            )}
          </section>

          <section>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">Check-in</h2>
              <p className="text-sm text-neutral-600">{checkInSummary}</p>
            </div>
            <button
              type="button"
              className="mt-2 h-11 w-full border border-black bg-black text-white disabled:opacity-40"
              disabled={!linked || followers.length === 0}
              onClick={() => void app.checkIn(BROADCAST_ID)}
            >
              {followers.length > 1 ? `Check in all ${followers.length}` : "Check in"}
            </button>
          </section>

          <section>
            <h2 className="text-sm font-medium">
              Followers{followers.length > 0 ? ` (${followers.length})` : ""}
            </h2>
            {followers.length === 0 && (
              <p className="mt-2 text-sm text-neutral-600">
                Waiting for the other boards. They show up when the leader hears them.
              </p>
            )}
            {!grouped && followers.length > 0 && (
              <p className="mt-2 text-sm text-neutral-600">
                Showing every board heard.{" "}
                <button type="button" className="underline" onClick={() => setView("settings")}>
                  Pick your group in Settings
                </button>{" "}
                to hide the rest.
              </p>
            )}
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
                  label={label(follower)}
                  now={now}
                  linked={linked}
                  onCheckIn={() => void app.checkIn(follower.id)}
                  emergency={state.emergencies.some((item) => item.id === follower.id)}
                  leaderFix={state.gpsFix}
                  leaderLat={state.gpsLat}
                  leaderLon={state.gpsLon}
                  heading={compass.heading}
                />
              ))}
            </div>
            {others.length > 0 && (
              <p className="mt-4 text-sm text-neutral-500">
                {others.length} other board{others.length === 1 ? "" : "s"} nearby, not in your group.
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

/** "87%", "On USB power", or null before the first report. */
function batteryText(percent: number | null): string | null {
  if (percent == null) return null;
  if (percent > 100) return "On USB power";
  return `${Math.round(percent)}%`;
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
  emergency,
  label,
  leaderFix,
  leaderLat,
  leaderLon,
  heading,
}: {
  follower: TrackedFollower;
  now: number;
  linked: boolean;
  onCheckIn: () => void;
  emergency: boolean;
  label: string;
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
  const alarm = follower.outOfRange || follower.silent;
  const status = follower.checkIn?.status;
  const busy = status === "sending" || status === "waiting" || status === "received";

  return (
    <article
      className={`border px-3 py-3 ${
        emergency ? "border-4 border-red-700 bg-red-50" : alarm ? "border-red-700" : "border-neutral-200"
      }`}
    >
      {emergency && <p className="mb-2 text-sm font-bold text-red-700">EMERGENCY</p>}
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <p className={`text-sm ${follower.silent ? "text-red-700" : "text-neutral-600"}`}>
          {follower.silent ? "Lost contact · " : ""}
          {follower.lastHeardAt == null ? "not heard yet" : `heard ${ago(follower.lastHeardAt, now)}`}
        </p>
      </div>
      <p className={`mt-2 text-3xl tabular-nums ${follower.silent ? "text-neutral-400" : ""}`}>
        {follower.separationKnown === true
          ? formatSeparation(follower.separationM)
          : follower.separationKnown === false
            ? "No fix"
            : "—"}
      </p>
      {follower.battery && batteryText(follower.battery.percent) && (
        <p
          className={`mt-2 text-sm ${
            (follower.battery.percent ?? 100) < 20 ? "text-red-700" : "text-neutral-600"
          }`}
        >
          Battery {batteryText(follower.battery.percent)} · {ago(follower.battery.at, now)}
        </p>
      )}
      {follower.lastText && (
        <p className="mt-2 text-sm text-neutral-600">
          Last message: &ldquo;{follower.lastText.text}&rdquo; · {ago(follower.lastText.at, now)}
        </p>
      )}
      {follower.recentTexts.length > 1 && (
        <details className="mt-1 text-xs text-neutral-600">
          <summary className="cursor-pointer">Button log</summary>
          <ul className="mt-1 font-mono">
            {follower.recentTexts.map((item, index) => {
              const older = follower.recentTexts[index + 1];
              return (
                <li key={`${item.at}-${index}`}>
                  {new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}.
                  {String(Math.floor((item.at % 1000) / 100))} &ldquo;{item.text}&rdquo;
                  {older ? ` · +${((item.at - older.at) / 1000).toFixed(1)} s` : ""}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {follower.placeholder && (
        <p className="mt-1 text-sm text-neutral-600">
          In your group, but the leader has not heard it on the radio. Check that it is on, has its antenna, and
          matches in Board setup (region, channel).
        </p>
      )}
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
          disabled={!linked || busy || follower.placeholder}
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
