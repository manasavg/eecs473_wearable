"use client";

import { useEffect, useState } from "react";
import { BROADCAST_ID } from "@/lib/ble/constants";
import { isNativeShell } from "@/lib/ble/create-transport";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { BLE_NAME_PREFIX } from "@/lib/ble/uuids";
import { formatUwbDistance } from "@/lib/format";
import { useExcursion } from "./use-excursion";

export function ExcursionApp() {
  const app = useExcursion();
  const { state } = app;
  const linked = state.connection === "connected";
  const onLink = state.mode !== "idle";
  const [ble, setBle] = useState<boolean | null>(null);
  const [nativeShell, setNativeShell] = useState(false);

  useEffect(() => {
    const native = isNativeShell();
    setNativeShell(native);
    setBle(native || webBluetoothAvailable());
  }, []);

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
            Connect to the LoRa leader ({BLE_NAME_PREFIX}). Distance comes from the separate UWB boards.
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

          <section className="border-t border-neutral-200 pt-6">
            <h2 className="text-sm font-medium">UWB</h2>
            <p className="mt-2 text-4xl tabular-nums">{formatUwbDistance(state.uwbDistanceM)}</p>
            <p className="mt-2 text-sm text-neutral-600">
              Anchor to tag. The LoRa board only forwards this number.
            </p>
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
