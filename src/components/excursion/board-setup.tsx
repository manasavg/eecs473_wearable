"use client";

import { useEffect, useState } from "react";
import type { BoardSetupState } from "@/lib/ble/app-client";
import {
  CHANNEL_NAME_MAX,
  DEFAULT_GPS_UPDATE_SECS,
  DEFAULT_HEARTBEAT_SECS,
  DEFAULT_POSITION_SECS,
  DEFAULT_REGION,
  REGIONS,
  TEAM_PRESET,
  presetName,
  regionName,
  POSITION_SECS_MAX,
  POSITION_SECS_MIN,
  base64ToKey,
  bytesToBase64,
  checkPlan,
  differences,
  generateKey,
  type BoardPlan,
  type BoardSettings,
} from "@/lib/meshtastic/setup";
import { loadTeam, saveTeam } from "@/lib/settings";

/**
 * "Set up this board": puts the connected board on the team's private channel,
 * sets position reporting, and turns on the OK button. Run it once per board.
 */
export function BoardSetup({
  board,
  setup,
  linked,
  onSetUp,
}: {
  board: BoardSettings | null;
  setup: BoardSetupState;
  linked: boolean;
  onSetUp: (plan: BoardPlan) => Promise<void>;
}) {
  const [channelName, setChannelName] = useState("Excursion");
  const [keyText, setKeyText] = useState("");
  const [positionText, setPositionText] = useState(String(DEFAULT_POSITION_SECS));
  const [pinText, setPinText] = useState("");
  const [region, setRegion] = useState<number>(DEFAULT_REGION);
  const [hasSavedTeam, setHasSavedTeam] = useState(false);
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

  return (
    <details className="border-t border-neutral-200 pt-6" open={diffs != null && diffs.length > 0}>
      <summary className="cursor-pointer text-sm font-medium">
        Board setup
        {diffs == null ? "" : matches ? " · this board matches the team" : " · this board needs setup"}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-neutral-600">
          Puts the connected board on your team&apos;s private channel, sets how often it reports its position, and
          turns on its OK button. Connect to each board in turn and set it up. Every board must use the same channel
          name and key.
        </p>

        {diffs != null && (
          <div
            className={`border px-3 py-2 text-sm ${
              matches ? "border-green-700 bg-green-50 text-green-900" : "border-amber-600 bg-amber-50 text-amber-900"
            }`}
          >
            {matches ? (
              <p>This board matches the team setup.</p>
            ) : (
              <>
                <p className="font-medium">This board differs from the team setup:</p>
                <ul className="mt-1 list-disc pl-5">
                  {diffs.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-sm text-neutral-600">Team channel name (up to {CHANNEL_NAME_MAX} characters)</span>
          <input
            type="text"
            value={channelName}
            maxLength={CHANNEL_NAME_MAX}
            className="h-11 border border-neutral-300 px-3"
            onChange={(event) => setChannelName(event.target.value)}
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
            onChange={(event) => setKeyText(event.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            className="h-10 border border-neutral-300 bg-white px-3 text-sm"
            onClick={() => {
              if (
                hasSavedTeam &&
                !window.confirm(
                  "Boards already set up with the old key will stop hearing boards set up with the new key. Make a new key?",
                )
              ) {
                return;
              }
              setKeyText(bytesToBase64(generateKey()));
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
        <p className="text-sm text-neutral-600">
          Anyone with this key can join the channel. To set up boards from another phone, paste the same key there.
        </p>

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
        <p className="text-sm text-neutral-600">
          Use US in the United States. Every board must match. Setup also sets the {presetName(TEAM_PRESET)} preset.
          {board?.region != null && ` This board: region ${regionName(board.region)}, preset ${presetName(board.modemPreset)}.`}
        </p>

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
          Keep the position interval shorter than the lost-contact time. Setup also makes the board report its
          battery every {DEFAULT_HEARTBEAT_SECS} s, with or without a GPS fix, so it is not flagged as lost
          indoors. The board also reads its GPS every{" "}
          {DEFAULT_GPS_UPDATE_SECS} s, which uses more battery than Meshtastic&apos;s default. Leave the GPIO blank for
          a board with no OK button wired.
        </p>

        {problem && <p className="text-sm text-red-700">{problem}</p>}
        <button
          type="button"
          className="h-11 border border-black bg-black text-white disabled:opacity-40"
          disabled={!linked || !plan || problem != null || working || board == null}
          onClick={() => {
            if (!plan) return;
            const ok = window.confirm(
              `Move this board to the "${plan.channelName.trim()}" channel with the team key? ` +
                "Until every board is set up, boards on the old channel will not hear it.",
            );
            if (!ok) return;
            saveTeam({
              channelName: plan.channelName.trim(),
              keyBase64: keyText.trim(),
              positionSecs: plan.positionSecs,
              okButtonPin: plan.okButtonPin,
              region: plan.region,
            });
            setHasSavedTeam(true);
            void onSetUp(plan);
          }}
        >
          {working ? "Setting up…" : "Set up this board"}
        </button>
        {board == null && linked && (
          <p className="text-sm text-neutral-600">Reading this board&apos;s settings…</p>
        )}
        {setup.message && (
          <p className={`text-sm ${setup.status === "error" ? "text-red-700" : "text-neutral-600"}`} role="status">
            {setup.message}
          </p>
        )}
      </div>
    </details>
  );
}
