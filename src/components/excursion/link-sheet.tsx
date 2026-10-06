"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { PACKET_VERSION } from "@/lib/ble/constants";
import { NATIVE_BLE_TODO } from "@/lib/ble/native-transport.todo";
import {
  ALERT_UUID,
  BLE_NAME_PREFIX,
  COMMAND_UUID,
  EXCURSION_SERVICE_UUID,
  FOLLOWER_STATUS_UUID,
  LEADER_STATUS_UUID,
  getBleNamePrefix,
  setBleNamePrefix,
} from "@/lib/ble/uuids";
import { ANGLE_SIGN } from "@/lib/ble/protocol";

export function LinkSheet({
  deviceName,
  onLeave,
}: {
  deviceName: string | null;
  onLeave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(getBleNamePrefix);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button type="button" variant="outline" className="h-10 px-3" />}>
        Beacon link
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-3xl">
        <SheetHeader>
          <SheetTitle className="font-display text-2xl">Beacon link</SheetTitle>
          <SheetDescription>
            {deviceName ? `Talking to ${deviceName}.` : "Not linked."} Packet version {PACKET_VERSION}.
            Angle sign {ANGLE_SIGN === 1 ? "clockwise" : "flipped"}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-8 text-sm">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Advertised name prefix</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-11 rounded-lg border bg-background px-3 text-base"
              maxLength={29}
              aria-label="Advertised name prefix"
            />
            <span className="text-xs text-muted-foreground">
              The chooser looks for a name starting with this. Default in code is “{BLE_NAME_PREFIX}”.
              Change it here to match the module already paired to the phone, then connect again.
            </span>
          </label>
          <Button
            type="button"
            className="h-11"
            onClick={() => {
              setBleNamePrefix(name);
              setName(getBleNamePrefix());
            }}
          >
            Save name
          </Button>

          <dl className="space-y-2 font-mono text-[11px] leading-relaxed break-all">
            <Uuid label="Service" value={EXCURSION_SERVICE_UUID} />
            <Uuid label="Leader" value={LEADER_STATUS_UUID} />
            <Uuid label="Follower" value={FOLLOWER_STATUS_UUID} />
            <Uuid label="Alert" value={ALERT_UUID} />
            <Uuid label="Command" value={COMMAND_UUID} />
          </dl>

          <p className="text-xs text-muted-foreground">
            UUIDs and the byte layout live in <code>src/lib/ble/uuids.ts</code> and{" "}
            <code>src/lib/ble/protocol.ts</code>. Search the repo for <code>TODO(ble)</code> before
            wiring a module. {NATIVE_BLE_TODO}
          </p>

          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => {
              setOpen(false);
              onLeave();
            }}
          >
            Leave group
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Uuid({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
