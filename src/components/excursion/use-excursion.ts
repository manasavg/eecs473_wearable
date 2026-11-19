"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExcursionAppClient,
  nodeSuffix,
  peerSuffix,
  type AppState,
  type GroupMember,
} from "@/lib/ble/app-client";
import { isNativeShell } from "@/lib/ble/create-transport";
import { rememberedNativeBeaconName } from "@/lib/ble/native-transport";
import type { BlePeer } from "@/lib/ble/transport";
import type { BoardPlan } from "@/lib/meshtastic/setup";
import { setUpOtherBoard } from "@/lib/ble/setup-other";
import { rememberedBeaconName } from "@/lib/ble/web-bluetooth-transport";
import {
  loadGroup,
  loadLastKnown,
  loadNames,
  loadSettings,
  saveGroup,
  saveLastKnown,
  saveNames,
  saveSettings,
} from "@/lib/settings";

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
  /** Names chosen in the app, by the last 4 hex digits of each board's node number. */
  const [names, setNames] = useState<Record<string, string>>({});
  /** Progress of setting up boards other than the leader, by Bluetooth device id. */
  const [otherSetup, setOtherSetup] = useState<
    Record<string, { status: "working" | "done" | "error"; message: string }>
  >({});

  useEffect(() => {
    setNames(loadNames());
  }, []);

  useEffect(() => {
    const saved = loadSettings();
    client.setThreshold(saved.thresholdMeters);
    client.setSilenceSeconds(saved.silenceSeconds);
    client.setRequireConfirm(saved.requireConfirm);
    client.rememberLastKnown(loadLastKnown());
    client.setGroup(loadGroup());
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
    (meters: number, silenceSeconds: number, requireConfirm: boolean) => {
      client.setThreshold(meters);
      client.setSilenceSeconds(silenceSeconds);
      client.setRequireConfirm(requireConfirm);
      const next = client.getState();
      saveSettings({
        thresholdMeters: next.thresholdMeters,
        silenceSeconds: next.silenceSeconds,
        requireConfirm: next.requireConfirm,
      });
    },
    [client],
  );

  const setUpBoard = useCallback(
    async (plan: BoardPlan) => {
      try {
        await client.setUpBoard(plan);
      } catch {
        // The client stores the message on state.boardSetup.
      }
    },
    [client],
  );

  /** Add or remove a board from the team. The group is saved on the phone. */
  const setGroup = useCallback(
    (group: GroupMember[]) => {
      client.setGroup(group);
    },
    [client],
  );

  // The client also corrects the group itself when it learns a board's real node number,
  // so save it whenever it changes rather than only when edited here.
  const savedGroup = useRef<string | null>(null);
  useEffect(() => {
    const snapshot = JSON.stringify(state.group);
    if (savedGroup.current === null) {
      savedGroup.current = snapshot;
      return;
    }
    if (snapshot === savedGroup.current) return;
    savedGroup.current = snapshot;
    saveGroup(state.group);
  }, [state.group]);

  /** A board's Bluetooth digits turned out to differ from its node number's: move its name too. */
  const moveName = useCallback((from: string, to: string) => {
    if (from === to) return;
    setNames((current) => {
      if (!current[from] || current[to]) return current;
      const next = { ...current, [to]: current[from] };
      delete next[from];
      saveNames(next);
      return next;
    });
  }, []);

  const learn = useCallback(
    (bleSuffix: string, nodeId: number) => {
      client.learnBoard(bleSuffix, nodeId);
      moveName(bleSuffix, nodeSuffix(nodeId));
    },
    [client, moveName],
  );

  // The leader's real node number arrives after connecting; its name follows the same rule.
  const leaderBleSuffix = state.leaderBleSuffix;
  const leaderId = state.leaderId;
  useEffect(() => {
    if (leaderBleSuffix && leaderId != null) moveName(leaderBleSuffix, nodeSuffix(leaderId));
  }, [leaderBleSuffix, leaderId, moveName]);

  const renameBoard = useCallback((suffix: string, name: string) => {
    setNames((current) => {
      const next = { ...current };
      if (name.trim()) next[suffix] = name.trim();
      else delete next[suffix];
      saveNames(next);
      return next;
    });
  }, []);

  /** Set up a board that is not the leader. The link to the leader stays up. */
  const setUpOther = useCallback(async (peer: BlePeer | null, plan: BoardPlan) => {
    const key = peer?.deviceId ?? "chooser";
    const report = (status: "working" | "done" | "error", message: string) =>
      setOtherSetup((current) => ({ ...current, [key]: { status, message } }));
    try {
      const { result, nodeId } = await setUpOtherBoard(peer, plan, (message) => report("working", message));
      // Its real node number is known now. Match the group entry and its name by it.
      const bleSuffix = peer ? peerSuffix(peer.name) : null;
      if (bleSuffix && nodeId != null) learn(bleSuffix, nodeId);
      report(
        "done",
        result === "confirmed"
          ? "Done. The board saved the settings."
          : "Settings sent. The board is restarting to apply them.",
      );
    } catch (error) {
      report("error", error instanceof Error ? error.message : String(error));
    }
  }, [learn]);

  return {
    state,
    names,
    renameBoard,
    otherSetup,
    setUpOther,
    acknowledgeEmergency: (id: number) => client.acknowledgeEmergency(id),
    setGroup,
    setUpBoard,
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
