"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExcursionAppClient, type AppState } from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { rememberedNativeBeaconName } from "@/lib/ble/native-transport";
import { rememberedBeaconName } from "@/lib/ble/web-bluetooth-transport";

export function useExcursion() {
  const clientRef = useRef<ExcursionAppClient | null>(null);
  if (!clientRef.current) clientRef.current = new ExcursionAppClient();
  const client = clientRef.current;

  const [state, setState] = useState<AppState>(() => client.getState());
  const [rememberedName, setRememberedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return {
    state,
    rememberedName,
    busy,
    connectBeacon,
    leave,
    checkIn,
    dismissError: () => client.dismissError(),
  };
}
