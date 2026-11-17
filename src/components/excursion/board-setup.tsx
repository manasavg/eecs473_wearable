"use client";

import { useEffect, useState } from "react";
import type { BoardSetupState } from "@/lib/ble/app-client";
import type { BlePeer } from "@/lib/ble/transport";
import {
  CHANNEL_NAME_MAX,
  DEFAULT_GPS_UPDATE_SECS,
  DEFAULT_HEARTBEAT_SECS,
  DEFAULT_POSITION_SECS,
  DEFAULT_REGION,
  POSITION_SECS_MAX,
  POSITION_SECS_MIN,
  REGIONS,
  TEAM_PRESET,
  base64ToKey,
  bytesToBase64,
  checkPlan,
  differences,
  generateKey,
  presetName,
  regionName,
  type BoardPlan,
  type BoardSettings,
} from "@/lib/meshtastic/setup";
import { loadTeam, saveTeam } from "@/lib/settings";

export interface OtherBoard {
  peer: BlePeer;
  /** The name to show: the one chosen in the app, or the board's Bluetooth name. */
  label: string;
}

export type OtherSetupStatus = Record<string, { status: "working" | "done" | "error"; message: string }>;

/**
 * Board setup: puts boards on the team's private channel, sets how often they report, and turns
 * on the OK button. The leader is set up over its own link. Every other board is set up over a
 * short second Bluetooth link, without making it the leader.
 */
export function BoardSetup({
  board,
  setup,
  linked,
  leaderLabel,
  onSetUp,
  native,
  others,
  scanning,
  onScan,
  onSetUpOther,
  otherSetup,
}: {
  board: BoardSettings | null;
  setup: BoardSetupState;
  linked: boolean;
  leaderLabel: string;
  onSetUp: (plan: BoardPlan) => Promise<void>;
  native: boolean;
  others: OtherBoard[];
  scanning: boolean;
  onScan: () => void;
  onSetUpOther: (peer: BlePeer | null, plan: BoardPlan) => Promise<void>;
  otherSetup: OtherSetupStatus;
}) {
  const [channelName, setChannelName] = useState("Excursion");
  const [keyText, setKeyText] = useState("");
  const [positionText, setPositionText] = useState(String(DEFAULT_POSITION_SECS));
  const [pinText, setPinText] = useState("");
  const [region, setRegion] = useState<number>(DEFAULT_REGION);
  const [hasSavedTeam, setHasSavedTeam] = useState(false);
  const [fromLeader, setFromLeader] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const team = loadTeam();
    if (team) {
      setChannelName(team.channelName);
      setKeyText(team.keyBase64);
      setPositionText(String(team.positionSecs));
      setPinText(team.okButtonPin == null ? "" : String(team.okButtonPin));
      setRegion(team.region);
      setHasSavedTeam(true);
    } else {
      setKeyText(bytesToBase64(generateKey()));
    }
  }, []);

  // Once the leader is on a private channel, every other board should join that one.
  // Fill in its name and key, so followers get the leader's key without copying it.
  const leaderKey = board?.keyBase64 ?? null;
  const leaderChannel = board?.channelName ?? null;
  const leaderRegion = board?.region ?? null;
  useEffect(() => {
    if (!leaderKey || !leaderChannel || !base64ToKey(leaderKey)) return;
    setKeyText(leaderKey);
    setChannelName(leaderChannel);
    if (leaderRegion) setRegion(leaderRegion);
    setFromLeader(true);
  }, [leaderKey, leaderChannel, leaderRegion]);

  const key = base64ToKey(keyText);
  const plan: BoardPlan | null = key
    ? {
        channelName,
        key,
        positionSecs: Number.parseInt(positionText, 10),
        gpsUpdateSecs: DEFAULT_GPS_UPDATE_SECS,
        okButtonPin: pinText.trim() === "" ? null : Number.parseInt(pinText, 10),
        region,
        heartbeatSecs: DEFAULT_HEARTBEAT_SECS,
      }
    : null;
  const problem = plan ? checkPlan(plan) : "The team key is not valid. Paste the team key or generate a new one.";
  const diffs = board && plan ? differences(board, plan) : null;
  const matches = diffs != null && diffs.length === 0;
  const working = setup.status === "working";
  const anyOtherWorking = Object.values(otherSetup).some((item) => item.status === "working");

  const remember = (current: BoardPlan) => {
    saveTeam({
      channelName: current.channelName.trim(),
      keyBase64: keyText.trim(),
      positionSecs: current.positionSecs,
      okButtonPin: current.okButtonPin,
      region: current.region,
    });
    setHasSavedTeam(true);
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Board setup</h2>
      <p className="text-sm text-neutral-600">
        Puts every board on your team&apos;s private channel, sets how often it reports, and turns on its OK button.
        Set up the leader, then each other board from the list below. Every board gets the same settings.
      </p>

      <h3 className="mt-2 text-sm font-medium">Team settings</h3>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-neutral-600">Team channel name (up to {CHANNEL_NAME_MAX} characters)</span>
        <input
          type="text"
          value={channelName}
          maxLength={CHANNEL_NAME_MAX}
          className="h-11 border border-neutral-300 px-3"
          onChange={(event) => {
            setChannelName(event.target.value);
            setFromLeader(false);
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-neutral-600">Team key</span>
        <input
          type="text"
          value={keyText}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 border border-neutral-300 px-3 font-mono text-xs"
          onChange={(event) => {
            setKeyText(event.target.value);
            setFromLeader(false);
          }}
        />
      </label>
      {fromLeader && (
        <p className="text-sm text-green-800">Using the leader&apos;s channel and key, so the other boards join it.</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="h-10 border border-neutral-300 bg-white px-3 text-sm"
          onClick={() => {
            if (
              (hasSavedTeam || fromLeader) &&
              !window.confirm(
                "Boards already set up with the current key will stop hearing boards set up with a new one. Make a new key?",
              )
            ) {
              return;
            }
            setKeyText(bytesToBase64(generateKey()));
            setFromLeader(false);
          }}
        >
          New key
        </button>
        <button
          type="button"
          className="h-10 border border-neutral-300 bg-white px-3 text-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(keyText).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </button>
      </div>
      <p className="text-sm text-neutral-600">Anyone with this key can join the channel.</p>

      <label className="flex items-center gap-2">
        <span className="w-36 text-sm text-neutral-600">Region</span>
        <select
          value={region}
          className="h-11 border border-neutral-300 bg-white px-2"
          onChange={(event) => setRegion(Number(event.target.value))}
        >
          {REGIONS.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-36 text-sm text-neutral-600">Position every</span>
        <input
          type="number"
          inputMode="numeric"
          min={POSITION_SECS_MIN}
          max={POSITION_SECS_MAX}
          value={positionText}
          className="h-11 w-24 border border-neutral-300 px-3 tabular-nums"
          onChange={(event) => setPositionText(event.target.value)}
        />
        <span className="text-sm text-neutral-600">s</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-36 text-sm text-neutral-600">OK button GPIO</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={48}
          placeholder="none"
          value={pinText}
          className="h-11 w-24 border border-neutral-300 px-3 tabular-nums"
          onChange={(event) => setPinText(event.target.value)}
        />
      </label>
      <p className="text-sm text-neutral-600">
        Use US in the United States. Setup also sets the {presetName(TEAM_PRESET)} preset, a battery report every{" "}
        {DEFAULT_HEARTBEAT_SECS} s so a board without a GPS fix is still heard, and a GPS read every{" "}
        {DEFAULT_GPS_UPDATE_SECS} s. Leave the GPIO blank for a board with no OK button.
      </p>
      {problem && <p className="text-sm text-red-700">{problem}</p>}

      <h3 className="mt-4 text-sm font-medium">Leader · {leaderLabel}</h3>
      {diffs != null && (
        <div
          className={`border px-3 py-2 text-sm ${
            matches ? "border-green-700 bg-green-50 text-green-900" : "border-amber-600 bg-amber-50 text-amber-900"
          }`}
        >
          {matches ? (
            <p>Matches the team setup.</p>
          ) : (
            <>
              <p className="font-medium">Differs from the team setup:</p>
              <ul className="mt-1 list-disc pl-5">
                {diffs.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {board?.region != null && (
            <p className="mt-1 text-xs">
              Region {regionName(board.region)}, preset {presetName(board.modemPreset)}.
            </p>
          )}
        </div>
      )}
      {board == null && linked && <p className="text-sm text-neutral-600">Reading the leader&apos;s settings…</p>}
      <button
        type="button"
        className="h-11 border border-black bg-black text-white disabled:opacity-40"
        disabled={!linked || !plan || problem != null || working || board == null}
        onClick={() => {
          if (!plan) return;
          const ok = window.confirm(
            `Move the leader to the "${plan.channelName.trim()}" channel with the team key? ` +
              "Boards not set up yet will not hear it until they are.",
          );
          if (!ok) return;
          remember(plan);
          void onSetUp(plan);
        }}
      >
        {working ? "Setting up…" : "Set up the leader"}
      </button>
      {setup.message && (
        <p className={`text-sm ${setup.status === "error" ? "text-red-700" : "text-neutral-600"}`} role="status">
          {setup.message}
        </p>
      )}

      <h3 className="mt-4 text-sm font-medium">Other boards</h3>
      <p className="text-sm text-neutral-600">
        Sets up a board over its own short Bluetooth link. The leader stays connected. Keep the board near the phone.
      </p>
      {native ? (
        <>
          <button
            type="button"
            className="h-11 border border-black bg-white disabled:opacity-40"
            disabled={scanning || anyOtherWorking}
            onClick={onScan}
          >
            {scanning ? "Looking…" : "Find boards"}
          </button>
          <ul className="flex flex-col gap-2">
            {others.map((other) => {
              const status = otherSetup[other.peer.deviceId];
              return (
                <li key={other.peer.deviceId} className="border border-neutral-300 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{other.label}</span>
                    <button
                      type="button"
                      className="h-10 shrink-0 border border-black bg-black px-3 text-sm text-white disabled:opacity-40"
                      disabled={!plan || problem != null || anyOtherWorking}
                      onClick={() => {
                        if (!plan) return;
                        remember(plan);
                        void onSetUpOther(other.peer, plan);
                      }}
                    >
                      {status?.status === "working" ? "Setting up…" : "Set up"}
                    </button>
                  </div>
                  {other.label !== other.peer.name && (
                    <p className="text-xs text-neutral-500">{other.peer.name}</p>
                  )}
                  {status && (
                    <p
                      className={`mt-1 text-sm ${
                        status.status === "error"
                          ? "text-red-700"
                          : status.status === "done"
                            ? "text-green-800"
                            : "text-neutral-600"
                      }`}
                      role="status"
                    >
                      {status.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {!scanning && others.length === 0 && (
            <p className="text-sm text-neutral-600">No other boards found yet. Tap Find boards.</p>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className="h-11 border border-black bg-white disabled:opacity-40"
            disabled={!plan || problem != null || anyOtherWorking}
            onClick={() => {
              if (!plan) return;
              remember(plan);
              void onSetUpOther(null, plan);
            }}
          >
            Choose a board to set up
          </button>
          {otherSetup.chooser && (
            <p
              className={`text-sm ${otherSetup.chooser.status === "error" ? "text-red-700" : "text-neutral-600"}`}
              role="status"
            >
              {otherSetup.chooser.message}
            </p>
          )}
        </>
      )}
      <p className="text-sm text-neutral-600">
        After setting up a board, restart it so the OK button and battery reports start.
      </p>
    </section>
  );
}
