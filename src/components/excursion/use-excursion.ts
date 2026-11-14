"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExcursionAppClient, type AppState } from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { rememberedNativeBeaconName } from "@/lib/ble/native-transport";
import type { BlePeer } from "@/lib/ble/transport";
import { rememberedBeaconName } from "@/lib/ble/web-bluetooth-transport";
import { loadLastKnown, loadSettings, saveLastKnown, saveSettings } from "@/lib/settings";

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
    const saved = loadSettings();
    client.setThreshold(saved.thresholdMeters);
    client.setSilenceSeconds(saved.silenceSeconds);
    client.rememberLastKnown(loadLastKnown());
  }, [client]);

  // Save last known fixes whenever one changes, so a reconnect or restart still has them.
  const savedFixes = useRef("");
  useEffect(() => {
    const snapshot = JSON.stringify(client.getLastKnown());
    if (snapshot === savedFixes.current || snapshot === "{}") return;
    savedFixes.current = snapshot;
    saveLastKnown(client.getLastKnown());
  }, [client, state.followers]);

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

  /** Save the range and silence limits on the phone. They apply right away. */
  const saveLimits = useCallback(
    (meters: number, silenceSeconds: number) => {
      client.setThreshold(meters);
      client.setSilenceSeconds(silenceSeconds);
      const next = client.getState();
      saveSettings({ thresholdMeters: next.thresholdMeters, silenceSeconds: next.silenceSeconds });
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
    saveLimits,
    dismissError: () => client.dismissError(),
  };
}
