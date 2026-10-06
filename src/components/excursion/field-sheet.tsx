"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { MemberState } from "@/lib/ble/app-client";
import type { DemoControls } from "@/lib/ble/mock-transport";
import { formatDistance, wristbandName } from "@/lib/format";
import { useState } from "react";

export function FieldSheet({
  demo,
  members,
  nicknames,
  selectedId,
  thresholdM,
}: {
  demo: DemoControls;
  members: MemberState[];
  nicknames: Record<string, string>;
  selectedId: number | null;
  thresholdM: number;
}) {
  const [open, setOpen] = useState(false);
  const [drift, setDrift] = useState(false);
  const member = members.find((item) => item.deviceId === selectedId) ?? members[0] ?? null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button type="button" variant="outline" className="h-10 px-3" />}
      >
        Field test
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-3xl">
        <SheetHeader>
          <SheetTitle className="font-display text-2xl">Wristband stand-in</SheetTitle>
          <SheetDescription>
            These buttons do what the radios and the wristband buttons will do. The
            dashboard stays the same when the beacon firmware replaces them.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-8">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              aria-pressed={drift}
              onClick={() => {
                const next = !drift;
                setDrift(next);
                demo.setDrift(next);
              }}
            >
              {drift ? "Drift on" : "Let the group drift"}
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={() => demo.holdSync()}>
              Hold Sync
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => demo.forgetWristbands()}
            >
              Forget wristbands
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={() => demo.addWristband()}>
              Add wristband
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => demo.setLeaderBattery(12)}
            >
              Leader battery 12%
            </Button>
          </div>

          {member == null ? (
            <p className="text-sm text-muted-foreground">
              No wristbands on the link. Hold Sync assigns IDs 1 and 2, the same pairing the firmware does.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="font-display text-xl">
                  {wristbandName(member.deviceId, nicknames)}
                </h3>
                <p className="text-sm text-muted-foreground">
                  Distance {formatDistance(member.distanceM)} · separation line {thresholdM} m
                  {member.lab ? ` · UWB misses ${member.lab.missedPings}/10` : ""}
                </p>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.nudgeDistance(member.deviceId, -5)}>
                  −5 m
                </Button>
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.nudgeDistance(member.deviceId, -1)}>
                  −1 m
                </Button>
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.nudgeDistance(member.deviceId, 1)}>
                  +1 m
                </Button>
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.nudgeDistance(member.deviceId, 5)}>
                  +5 m
                </Button>
              </div>
              <Button type="button" className="h-12" onClick={() => demo.tripSeparation(member.deviceId)}>
                Trip separation alert
              </Button>
              <p className="text-xs text-muted-foreground">
                At 40 m the module cannot report a longer distance, so the alert is 10 missed UWB pings.
                Lower the line first if you want a distance reading that is still on the dial.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.addMisses(member.deviceId, 1)}>
                  Miss one UWB ping
                </Button>
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.addMisses(member.deviceId, 10)}>
                  Lose UWB link
                </Button>
                <Button type="button" variant="outline" className="h-12" onClick={() => demo.restoreUwb(member.deviceId)}>
                  Back in UWB range
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12"
                  onClick={() =>
                    demo.setFollowerBattery(member.deviceId, Math.max(0, (member.batteryPercent ?? 50) - 15))
                  }
                >
                  Drain battery
                </Button>
              </div>
              <Button
                type="button"
                variant="destructive"
                className="h-12 bg-clay text-background hover:bg-clay/90"
                onClick={() => demo.pressNeedHelp(member.deviceId)}
              >
                3-second press — Need help
              </Button>
              <Button type="button" variant="secondary" className="h-12" onClick={() => demo.pressOk(member.deviceId)}>
                Response button — I&apos;m OK
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
