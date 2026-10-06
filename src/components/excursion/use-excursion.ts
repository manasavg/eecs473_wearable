"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ExcursionAppClient, type AppState } from "@/lib/ble/app-client";
import type { DemoControls } from "@/lib/ble/mock-transport";
import { rememberedBeaconName } from "@/lib/ble/web-bluetooth-transport";
import { activityText, wristbandName } from "@/lib/format";
import { buzzAlert, playAlarm, playOk, unlockAudio } from "@/lib/sound";

const THRESHOLD_KEY = "excursion.threshold";
const NAMES_KEY = "excursion.nicknames";
const SOUND_KEY = "excursion.sound";
const NIGHT_KEY = "excursion.night";

export function useExcursion() {
  const clientRef = useRef<ExcursionAppClient | null>(null);
  if (!clientRef.current) clientRef.current = new ExcursionAppClient();
  const client = clientRef.current;

  const [state, setState] = useState<AppState>(() => client.getState());
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [soundOn, setSoundOn] = useState(true);
  const [night, setNight] = useState(false);
  const [prefsReady, setPrefsReady] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [rememberedName, setRememberedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;
  const namesRef = useRef(nicknames);
  namesRef.current = nicknames;

  useEffect(() => {
    setNicknames(readJson(NAMES_KEY));
    setSoundOn(localStorage.getItem(SOUND_KEY) !== "off");
    setNight(localStorage.getItem(NIGHT_KEY) === "on");
    const saved = Number(localStorage.getItem(THRESHOLD_KEY));
    if (Number.isFinite(saved) && saved > 0) client.setThreshold(saved);
    setPrefsReady(true);
    void rememberedBeaconName().then(setRememberedName);
    return client.subscribe(setState);
  }, [client]);

  useEffect(() => {
    if (!prefsReady) return;
    document.documentElement.classList.toggle("dark", night);
    localStorage.setItem(NIGHT_KEY, night ? "on" : "off");
  }, [night, prefsReady]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      void client.disconnect();
    };
  }, [client]);

  const seenAlerts = useRef(new Set<string>());
  useEffect(() => {
    for (const alert of state.alerts) {
      const key = `${alert.deviceId}:${alert.status}:${alert.at}`;
      if (seenAlerts.current.has(key)) continue;
      seenAlerts.current.add(key);
      buzzAlert();
      if (soundRef.current) playAlarm();
    }
  }, [state.alerts]);

  const seenActivity = useRef(new Set<string>());
  const primed = useRef(false);
  useEffect(() => {
    if (!primed.current) {
      for (const entry of state.activity) seenActivity.current.add(entry.id);
      primed.current = true;
      return;
    }
    for (const entry of state.activity) {
      if (seenActivity.current.has(entry.id)) continue;
      seenActivity.current.add(entry.id);
      const text = activityText(entry, (id) => wristbandName(id, namesRef.current));
      if (entry.kind === "checkin") toast(text);
      if (entry.kind === "answered") {
        toast.success(text);
        if (soundRef.current) playOk();
      }
      if (entry.kind === "error") toast.error(text);
    }
  }, [state.activity]);

  useEffect(() => {
    setSelectedId((current) => {
      if (current != null && state.members.some((member) => member.deviceId === current)) {
        return current;
      }
      return state.members[0]?.deviceId ?? null;
    });
  }, [state.members]);

  const urgentKey = state.alerts[0] ? `${state.alerts[0].deviceId}:${state.alerts[0].at}` : "";
  useEffect(() => {
    if (!state.alerts[0]) return;
    setSelectedId(state.alerts[0].deviceId);
  }, [urgentKey, state.alerts]);

  const nameFor = useCallback(
    (id: number) => wristbandName(id, nicknames),
    [nicknames],
  );

  const connectDemo = useCallback(async () => {
    unlockAudio();
    setBusy(true);
    try {
      await client.connectDevice("demo");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the demo.");
    } finally {
      setBusy(false);
    }
  }, [client]);

  const connectBeacon = useCallback(
    async (remembered = false) => {
      unlockAudio();
      setBusy(true);
      try {
        await client.connectDevice("beacon", undefined, remembered);
        const name = await rememberedBeaconName();
        setRememberedName(name);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not connect to the beacon.");
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const leave = useCallback(async () => {
    await client.disconnect();
    setSelectedId(null);
  }, [client]);

  const checkIn = useCallback(
    async (targetId: number) => {
      unlockAudio();
      try {
        await client.sendCheckIn(targetId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Check-in failed.");
      }
    },
    [client],
  );

  const thresholdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setThreshold = useCallback(
    (meters: number) => {
      client.setThreshold(meters);
      const next = client.getState().thresholdMeters;
      localStorage.setItem(THRESHOLD_KEY, String(next));
      if (thresholdTimer.current) clearTimeout(thresholdTimer.current);
      thresholdTimer.current = setTimeout(() => {
        void client.writeThreshold();
      }, 280);
    },
    [client],
  );

  const rename = useCallback((id: number, name: string) => {
    setNicknames((current) => {
      const next = { ...current };
      const trimmed = name.trim();
      if (trimmed) next[String(id)] = trimmed;
      else delete next[String(id)];
      localStorage.setItem(NAMES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((current) => {
      const next = !current;
      localStorage.setItem(SOUND_KEY, next ? "on" : "off");
      if (next) unlockAudio();
      return next;
    });
  }, []);

  const demo: DemoControls | null = state.mode === "demo" ? client.demo() : null;
  const selected = state.members.find((member) => member.deviceId === selectedId) ?? null;

  return {
    state,
    now,
    nicknames,
    nameFor,
    soundOn,
    night,
    setNight,
    toggleSound,
    selectedId,
    setSelectedId,
    selected,
    rememberedName,
    busy,
    demo,
    connectDemo,
    connectBeacon,
    leave,
    checkIn,
    setThreshold,
    rename,
    dismissError: () => client.dismissError(),
  };
}

function readJson(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const names: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") names[id] = value;
    }
    return names;
  } catch {
    return {};
  }
}
