"use client";

import { useDeferredValue, useEffect, useState } from "react";
import { isPendingCheckIn, type FollowerCheckIn } from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { webBluetoothAvailable } from "@/lib/ble/web-bluetooth-transport";
import { BLE_NAME_PREFIX } from "@/lib/ble/uuids";
import { LiveGps } from "./live-gps";
import { useExcursion } from "./use-excursion";

export function ExcursionApp() {
  const app = useExcursion();
  const { state } = app;
  const linked = state.connection === "connected";
  const onLink = state.mode !== "idle";
  const gpsFix = useDeferredValue(state.gpsFix);
  const gpsLat = useDeferredValue(state.gpsLat);
  const gpsLon = useDeferredValue(state.gpsLon);
  const gpsRadios = useDeferredValue(state.followers);
  const [ble, setBle] = useState<boolean | null>(null);
  const [nativeShell, setNativeShell] = useState(false);
  const [looked, setLooked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const followers = state.followers;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const native = isNativeShell();
    setNativeShell(native);
    setBle(native || webBluetoothAvailable());
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
      <h1 className="text-xl font-semibold">Excursion</h1>

      {!onLink ? (
        <div className="mt-6 flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Pick your leader board from the {BLE_NAME_PREFIX} Bluetooth devices. Followers come from the leader’s Meshtastic node list and live radio traffic.
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
                        <span className="text-sm text-neutral-600">{app.busy ? "Connecting" : "Make leader"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {looked && !app.scanning && app.peers.length === 0 && !app.scanError && (
                <p className="text-sm text-neutral-600">No boards in range. Power on the boards, then look again.</p>
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
              {nativeShell ? "Bluetooth is unavailable." : "This browser has no Bluetooth. On iPhone, run the Xcode app."}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <p className="text-sm text-neutral-600">
            {linked ? "Leader connected" : state.connection === "scanning" ? "Connecting" : "Disconnected"}
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

          <section aria-label="Follower check-ins">
            <h2 className="text-base font-semibold">Followers ({followers.length})</h2>
            {followers.length === 0 && (
              <p className="mt-2 text-sm text-neutral-600">Waiting for the leader to report other nodes.</p>
            )}
            {linked && (
              <button
                type="button"
                className="mt-3 h-11 w-full border border-black bg-black text-white disabled:opacity-40"
                disabled={app.busy}
                onClick={() => void app.checkIn(followers.map((follower) => follower.id))}
              >
                Check in all
              </button>
            )}
            {linked && (
              <LiveGps fix={gpsFix} lat={gpsLat} lon={gpsLon} radios={gpsRadios} />
            )}
            <ul className="mt-3 flex flex-col gap-3">
              {followers.map((follower) => {
                const checkIn = state.checkIns[follower.id];
                const nodeId = `!${follower.id.toString(16).padStart(8, "0")}`;
                return (
                  <li key={follower.id} className="rounded-lg border border-neutral-300 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{follower.name || "Meshtastic node"}</p>
                        <p className="font-mono text-xs text-neutral-600">{nodeId}</p>
                        {checkIn?.status !== "ok" && (
                          <p role="status" className={checkIn?.status === "help" ? "text-sm font-semibold text-red-700" : "text-sm text-neutral-600"}>
                            {checkInLabel(checkIn, now)}
                          </p>
                        )}
                      </div>
                      {checkIn?.status === "ok" && (
                        <span role="status" className="shrink-0 rounded bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900">
                          OK
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
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

function checkInLabel(checkIn: FollowerCheckIn | undefined, now: number): string {
  if (!checkIn) return "Not checked in";
  const pending = isPendingCheckIn(checkIn, now);
  switch (checkIn.status) {
    case "sending": return "Sending…";
    case "waiting": return pending ? "Waiting for OK" : "No answer";
    case "received": return pending ? "Received · waiting for OK press" : "Received · no OK pressed";
    case "ok": return "OK · confirmed on board";
    case "help": return "Needs help";
    case "noAnswer": return "No answer";
    case "failed": return checkIn.reason ? `Not delivered · ${checkIn.reason}` : "Not delivered";
  }
}
