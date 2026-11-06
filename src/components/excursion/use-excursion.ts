"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExcursionAppClient, type AppState } from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { rememberedNativeBeaconName } from "@/lib/ble/native-transport";
import type { BlePeer } from "@/lib/ble/transport";
import { rememberedBeaconName } from "@/lib/ble/web-bluetooth-transport";

export function useExcursion() {
  const clientRef = useRef<ExcursionAppClient | null>(null);
  if (!clientRef.current) clientRef.current = new ExcursionAppClient();
  const client = clientRef.current;

  const [state, setState] = useState<AppState>(() => client.getState());
  const [rememberedName, setRememberedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peers, setPeers] = useState<BlePeer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    if (isNativeShell()) setRememberedName(rememberedNativeBeaconName());
    else void rememberedBeaconName().then(setRememberedName);
    return client.subscribe(setState);
  }, [client]);

  useEffect(() => {
    return () => {
      void client.disconnect();
    };
  }, [client]);

  const lookForDevices = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setPeers([]);
    try {
      await client.scanForDevices((peer) => {
        setPeers((current) => {
          if (current.some((item) => item.deviceId === peer.deviceId)) return current;
          return [...current, peer].sort((a, b) => a.name.localeCompare(b.name));
        });
      });
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Could not look for devices.");
    } finally {
      setScanning(false);
    }
  }, [client]);

  const connectPeer = useCallback(
    async (peer: BlePeer) => {
      setBusy(true);
      try {
        await client.connectDevice("beacon", undefined, false, peer);
        setRememberedName(peer.name);
      } catch {
        // The client stores the message on state.error.
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const connectBeacon = useCallback(
    async (remembered = false) => {
      setBusy(true);
      try {
        await client.connectDevice("beacon", undefined, remembered);
        if (isNativeShell()) setRememberedName(rememberedNativeBeaconName());
        else setRememberedName(await rememberedBeaconName());
      } catch {
        // The client stores the message on state.error.
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const leave = useCallback(async () => {
    await client.disconnect();
  }, [client]);

  const checkIn = useCallback(
    async (targetId: number) => {
      try {
        await client.sendCheckIn(targetId);
      } catch {
        // The client stores the message on state.error.
      }
    },
    [client],
  );

  const setRange = useCallback(
    async (meters: number) => {
      client.setThreshold(meters);
      try {
        await client.writeThreshold();
      } catch {
        // The client stores the message on state.error.
      }
    },
    [client],
  );

  return {
    state,
    rememberedName,
    busy,
    peers,
    scanning,
    scanError,
    lookForDevices,
    connectPeer,
    connectBeacon,
    leave,
    checkIn,
    setRange,
    dismissError: () => client.dismissError(),
  };
}
