"use client";

import { useEffect, useState } from "react";
import { Bluetooth, Moon, Sun, TriangleAlert, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { BROADCAST_ID, THRESHOLD_MAX_M, THRESHOLD_MIN_M } from "@/lib/ble/constants";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { Status } from "@/lib/ble/types";
import { activityText, batteryBand, formatAge, formatClock, statusLabel } from "@/lib/format";
import type { ActivityEntry } from "@/lib/ble/app-client";
import { cn } from "@/lib/utils";
import { CompassDial } from "./compass-dial";
import { FieldSheet } from "./field-sheet";
import { LinkSheet } from "./link-sheet";
import { MemberCard } from "./member-card";
import { useExcursion } from "./use-excursion";
import { usePhoneHeading } from "./use-heading";

export function ExcursionApp() {
  const app = useExcursion();
  const compass = usePhoneHeading();
  const { state, now } = app;
  const linked = state.connection === "connected";
  const onTrail = state.mode !== "idle";
  const [ble, setBle] = useState<boolean | null>(null);
  useEffect(() => {
    setBle(webBluetoothAvailable());
  }, []);
  const lowMembers = state.members.filter(
    (member) => member.batteryPercent != null && member.batteryPercent < 20,
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pt-5 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] tracking-[0.22em] text-muted-foreground uppercase">Leader</p>
          <h1 className="font-display text-4xl leading-none tracking-tight text-pine">Excursion</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            aria-pressed={app.night}
            aria-label={app.night ? "Use day colors" : "Use night colors"}
            onClick={() => app.setNight(!app.night)}
          >
            {app.night ? <Sun /> : <Moon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            aria-pressed={app.soundOn}
            aria-label={app.soundOn ? "Mute alerts" : "Play alert sounds"}
            onClick={app.toggleSound}
          >
            {app.soundOn ? <Volume2 /> : <VolumeX />}
          </Button>
          {onTrail && app.demo && (
            <FieldSheet
              demo={app.demo}
              members={state.members}
              nicknames={app.nicknames}
              selectedId={app.selectedId}
              thresholdM={state.thresholdMeters}
            />
          )}
          {onTrail && <LinkSheet deviceName={state.deviceName} onLeave={() => void app.leave()} />}
        </div>
      </header>

      {!onTrail ? (
        <Gate
          ble={ble}
          busy={app.busy}
          error={state.error}
          rememberedName={app.rememberedName}
          onDemo={() => void app.connectDemo()}
          onBeacon={() => void app.connectBeacon(false)}
          onRemembered={() => void app.connectBeacon(true)}
        />
      ) : (
        <div className="mt-5 grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-3">
            <StatusStrip
              mode={state.mode}
              connection={state.connection}
              deviceName={state.deviceName}
              leaderBattery={state.leaderBatteryPercent}
              lastPacketAt={state.lastPacketAt}
              now={now}
            />

            {state.error && (
              <div className="flex items-start justify-between gap-3 rounded-2xl border border-clay/40 bg-clay/10 px-4 py-3 text-sm" role="alert">
                <p>{state.error}</p>
                <button type="button" className="shrink-0 underline" onClick={app.dismissError}>
                  Dismiss
                </button>
              </div>
            )}

            {state.alerts.map((alert) => (
              <button
                key={`${alert.deviceId}-${alert.at}`}
                type="button"
                className={cn(
                  "rounded-2xl px-4 py-3 text-left",
                  alert.status === Status.NEED_HELP
                    ? "bg-clay text-background"
                    : "bg-bark text-background",
                )}
                onClick={() => app.setSelectedId(alert.deviceId)}
              >
                <span className="flex items-center gap-2 font-medium">
                  <TriangleAlert className="size-4" />
                  {app.nameFor(alert.deviceId)} · {statusLabel(alert.status)}
                </span>
                <span className="mt-1 block text-sm opacity-90">
                  {alert.status === Status.NEED_HELP
                    ? "They held the wristband button. Ask them to confirm, or go to the last fix."
                    : "They crossed the separation line or UWB lost them."}
                </span>
              </button>
            ))}

            {(lowMembers.length > 0 ||
              (state.leaderBatteryPercent != null && state.leaderBatteryPercent < 20)) && (
              <div className="rounded-2xl border border-signal/40 bg-signal/10 px-4 py-3 text-sm" role="status">
                {state.leaderBatteryPercent != null && state.leaderBatteryPercent < 20 && (
                  <p>Leader beacon is at {state.leaderBatteryPercent}%. Charge it before the link drops.</p>
                )}
                {lowMembers.map((member) => (
                  <p key={member.deviceId}>
                    {app.nameFor(member.deviceId)} is at {member.batteryPercent}% battery.
                  </p>
                ))}
              </div>
            )}

            <ThresholdControl
              meters={state.thresholdMeters}
              disabled={!linked}
              onChange={app.setThreshold}
            />

            {state.connection === "scanning" && state.members.length === 0 ? (
              <section className="rounded-3xl border bg-card px-5 py-8">
                <h2 className="font-display text-2xl">Opening the beacon</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {state.mode === "beacon"
                    ? "Choose the leader beacon in the system Bluetooth list. It should be the module clipped to this phone."
                    : "Starting the demo group."}
                </p>
              </section>
            ) : state.members.length === 0 ? (
              <section className="rounded-3xl border bg-card px-5 py-8">
                <h2 className="font-display text-2xl">No wristbands yet</h2>
                <p className="mt-2 max-w-prose text-sm text-muted-foreground">
                  Hold Sync on the beacon and on each band. The leader assigns IDs 1 and 2 over LoRa,
                  and both clocks start at zero. Cards show up on the next 2-second cycle.
                </p>
              </section>
            ) : (
              <div className="flex flex-col gap-3">
                {state.members.map((member) => (
                  <MemberCard
                    key={member.deviceId}
                    member={member}
                    nicknames={app.nicknames}
                    thresholdM={state.thresholdMeters}
                    now={now}
                    selected={member.deviceId === app.selectedId}
                    linked={linked}
                    onSelect={() => app.setSelectedId(member.deviceId)}
                    onCheckIn={() => void app.checkIn(member.deviceId)}
                    onRename={(name) => app.rename(member.deviceId, name)}
                  />
                ))}
              </div>
            )}

            <div className="md:hidden">
              <CompassDial
                member={app.selected}
                nicknames={app.nicknames}
                heading={compass.heading}
                compassStatus={compass.status}
                needsGesture={compass.needsGesture}
                onEnableCompass={() => void compass.start()}
              />
            </div>

            <ActivityLog activity={state.activity} nameFor={app.nameFor} />

            {state.members.length > 0 && (
              <div className="sticky bottom-3 z-10 md:hidden">
                <Button
                  type="button"
                  className="h-14 w-full text-base shadow-lg"
                  disabled={!linked}
                  onClick={() => void app.checkIn(BROADCAST_ID)}
                >
                  Check in everyone
                </Button>
              </div>
            )}
          </div>

          <aside className="sticky top-4 hidden flex-col gap-3 md:flex">
            <CompassDial
              member={app.selected}
              nicknames={app.nicknames}
              heading={compass.heading}
              compassStatus={compass.status}
              needsGesture={compass.needsGesture}
              onEnableCompass={() => void compass.start()}
            />
            <Button
              type="button"
              className="h-12 text-base"
              disabled={!linked || state.members.length === 0}
              onClick={() => void app.checkIn(BROADCAST_ID)}
            >
              Check in everyone
            </Button>
          </aside>
        </div>
      )}
    </div>
  );
}

function Gate({
  ble,
  busy,
  error,
  rememberedName,
  onDemo,
  onBeacon,
  onRemembered,
}: {
  ble: boolean | null;
  busy: boolean;
  error: string | null;
  rememberedName: string | null;
  onDemo: () => void;
  onBeacon: () => void;
  onRemembered: () => void;
}) {
  return (
    <main className="mt-8 flex max-w-xl flex-col gap-6">
      <div>
        <p className="font-display text-3xl leading-tight tracking-tight sm:text-4xl">
          Two wristbands. One beacon. This phone.
        </p>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-muted-foreground">
          Distance and direction inside 40 meters come from UWB. A check-in still reaches about
          1.5 km over LoRa. Nothing on this screen needs a cell signal. The beacon clips to the
          back of the phone, so the top of the screen is straight ahead.
        </p>
      </div>

      {error && (
        <p className="rounded-2xl border border-clay/40 bg-clay/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button type="button" className="h-12 text-base" disabled={ble === false || busy} onClick={onBeacon}>
          <Bluetooth />
          Connect the beacon
        </Button>
        {rememberedName && (
          <Button
            type="button"
            variant="outline"
            className="h-12 text-base"
            disabled={busy}
            onClick={onRemembered}
          >
            Reconnect {rememberedName}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          className="h-12 text-base"
          disabled={busy}
          onClick={onDemo}
        >
          Practice with a demo group
        </Button>
      </div>

      <p className="max-w-prose text-sm text-muted-foreground">
        {ble === false
          ? "This browser has no Bluetooth API. Chrome on Android can connect to the beacon. You can still practice with the demo group, and the iPhone transport is marked TODO(ble) in the code."
          : "Chrome will ask which Bluetooth device is the leader beacon. If the list is empty, set the advertised name to match your module. That field is in Beacon link once a group is open."}
      </p>
    </main>
  );
}

function StatusStrip({
  mode,
  connection,
  deviceName,
  leaderBattery,
  lastPacketAt,
  now,
}: {
  mode: "idle" | "demo" | "beacon";
  connection: string;
  deviceName: string | null;
  leaderBattery: number | null;
  lastPacketAt: number | null;
  now: number;
}) {
  const band = batteryBand(leaderBattery);
  const label =
    connection === "connected"
      ? "Linked"
      : connection === "reconnecting"
        ? "Reconnecting"
        : connection === "scanning"
          ? "Connecting"
          : "Link lost";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border bg-card px-4 py-3 text-sm">
      <span className="inline-flex items-center gap-2 font-medium">
        <span
          className={cn(
            "size-2 rounded-full",
            connection === "connected" ? "bg-moss" : "bg-signal",
          )}
        />
        {label}
        {mode === "demo" ? " · Demo group" : deviceName ? ` · ${deviceName}` : ""}
      </span>
      <span>
        Beacon battery{" "}
        <span className={cn("font-mono", band === "low" && "text-clay")}>
          {leaderBattery == null ? "—" : `${leaderBattery}%`}
        </span>
      </span>
      <span className="text-muted-foreground">Packet {formatAge(lastPacketAt, now)}</span>
    </div>
  );
}

function ThresholdControl({
  meters,
  disabled,
  onChange,
}: {
  meters: number;
  disabled: boolean;
  onChange: (meters: number) => void;
}) {
  return (
    <section className="rounded-3xl border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Separation line</h2>
        <p className="font-mono text-lg">{meters} m</p>
      </div>
      <Slider
        value={[meters]}
        min={THRESHOLD_MIN_M}
        max={THRESHOLD_MAX_M}
        step={1}
        disabled={disabled}
        aria-label="Separation distance in meters"
        className="mt-3"
        onValueChange={(value) => {
          const next = Array.isArray(value) ? value[0] : value;
          if (typeof next === "number") onChange(next);
        }}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        UWB measures up to {THRESHOLD_MAX_M} m. Past the line, the beacon raises an out-of-range
        alert. Check-ins use LoRa and do not need anyone inside this distance.
      </p>
    </section>
  );
}

function ActivityLog({
  activity,
  nameFor,
}: {
  activity: ActivityEntry[];
  nameFor: (id: number) => string;
}) {
  if (activity.length === 0) return null;
  return (
    <section className="rounded-3xl border bg-card px-4 py-3">
      <h2 className="text-sm font-medium">Trail log</h2>
      <ul className="mt-2 flex flex-col gap-1.5">
        {activity.slice(0, 6).map((entry) => (
          <li key={entry.id} className="flex gap-3 text-sm">
            <time className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
              {formatClock(entry.at)}
            </time>
            <span>{activityText(entry, nameFor)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
