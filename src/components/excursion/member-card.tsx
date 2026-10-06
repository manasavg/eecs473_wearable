"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MemberState } from "@/lib/ble/app-client";
import { Status } from "@/lib/ble/types";
import {
  batteryBand,
  checkInLine,
  formatBearing,
  formatDistance,
  statusLabel,
  wristbandName,
} from "@/lib/format";
import { cn } from "@/lib/utils";

export function MemberCard({
  member,
  nicknames,
  thresholdM,
  now,
  selected,
  linked,
  onSelect,
  onCheckIn,
  onRename,
}: {
  member: MemberState;
  nicknames: Record<string, string>;
  thresholdM: number;
  now: number;
  selected: boolean;
  linked: boolean;
  onSelect: () => void;
  onCheckIn: () => void;
  onRename: (name: string) => void;
}) {
  const name = wristbandName(member.deviceId, nicknames);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const band = batteryBand(member.batteryPercent);
  const line = checkInLine(member, now);
  const showLast =
    member.distanceM == null && (member.lastDistanceM != null || member.lastAngleDeg != null);

  return (
    <article
      className={cn(
        "rounded-3xl border bg-card p-4 transition-shadow",
        selected && "ring-2 ring-pine/30",
        member.status === Status.NEED_HELP && "help-pulse border-clay bg-clay/8",
        member.status === Status.OUT_OF_RANGE && "border-bark/50",
        member.status === Status.CHECKIN_PENDING && "border-signal/50",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
            ID {member.deviceId}
          </p>
          {editing ? (
            <form
              className="mt-1 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onRename(draft);
                setEditing(false);
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`Name for wristband ${member.deviceId}`}
                className="h-10 w-full min-w-0 rounded-lg border bg-background px-2 text-base"
                maxLength={32}
              />
              <Button type="submit" className="h-10 px-3">
                Save
              </Button>
            </form>
          ) : (
            <div className="mt-0.5 flex items-center gap-1">
              <button
                type="button"
                className="truncate text-left font-display text-[1.65rem] leading-none tracking-tight"
                onClick={onSelect}
              >
                {name}
              </button>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground hover:text-foreground"
                aria-label={`Rename ${name}`}
                onClick={() => {
                  setDraft(name);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3.5" />
              </button>
            </div>
          )}
        </div>
        <span className={cn("mt-1 shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", pillClass(member.status))}>
          {statusLabel(member.status)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Distance</p>
          <p className="font-mono text-3xl leading-none tracking-tight">
            {formatDistance(member.distanceM)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{distanceHint(member, thresholdM)}</p>
        </div>
        <div>
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Bearing</p>
          <p className="font-mono text-3xl leading-none tracking-tight">
            {member.angleDeg == null ? "—" : `${Math.round(member.angleDeg)}°`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{formatBearing(member.angleDeg)}</p>
        </div>
      </div>

      {showLast && (
        <p className="mt-3 text-sm text-muted-foreground">
          Last UWB fix {formatDistance(member.lastDistanceM)}
          {member.lastAngleDeg != null ? ` · ${formatBearing(member.lastAngleDeg)}` : ""}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", barClass(band))}
            style={{ width: `${member.batteryPercent ?? 0}%` }}
          />
        </div>
        <p className="text-sm">
          {member.batteryPercent == null ? "Battery unknown" : `${member.batteryPercent}% battery`}
        </p>
      </div>

      {line && <p className="mt-3 text-sm font-medium">{line}</p>}

      {member.lab && member.lab.missedPings > 0 && !member.uwbOutOfRange && (
        <p className="mt-2 text-xs text-muted-foreground">
          Demo: UWB missed {member.lab.missedPings} of 10. Still holding the last fix.
        </p>
      )}
      {member.lab &&
        member.lab.overThresholdCount > 0 &&
        member.status !== Status.OUT_OF_RANGE &&
        member.status !== Status.NEED_HELP && (
          <p className="mt-2 text-xs text-muted-foreground">
            Demo: past {thresholdM} m, reading {member.lab.overThresholdCount} of 3 before the alert.
          </p>
        )}

      <div className="mt-4 flex gap-2">
        <Button
          type="button"
          className="h-12 flex-1 text-base"
          disabled={!linked}
          onClick={onCheckIn}
        >
          {member.status === Status.OK ? "Check in" : "Ask if they're OK"}
        </Button>
        {!selected && (
          <Button type="button" variant="outline" className="h-12 px-4" onClick={onSelect}>
            Dial
          </Button>
        )}
      </div>
    </article>
  );
}

function distanceHint(member: MemberState, thresholdM: number): string {
  if (member.uwbOutOfRange) return "Beyond UWB · LoRa only";
  if (member.status === Status.OUT_OF_RANGE) return `Past the ${thresholdM} m line`;
  if (member.distanceM == null) return "No fix yet";
  return "UWB range";
}

function pillClass(status: Status): string {
  switch (status) {
    case Status.OK:
      return "bg-moss/15 text-moss";
    case Status.CHECKIN_PENDING:
      return "bg-signal/15 text-signal";
    case Status.NEED_HELP:
      return "bg-clay text-background";
    case Status.OUT_OF_RANGE:
      return "bg-bark text-background";
  }
}

function barClass(band: ReturnType<typeof batteryBand>): string {
  switch (band) {
    case "high":
      return "bg-moss";
    case "medium":
      return "bg-signal";
    case "low":
      return "bg-clay";
    case "unknown":
      return "bg-muted-foreground/40";
  }
}
