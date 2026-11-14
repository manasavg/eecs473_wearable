import { clone, create } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";

/** Meshtastic channel names must fit in 11 bytes. */
export const CHANNEL_NAME_MAX = 11;
/** 32 is full precision. 0 would stop sharing positions on the channel. */
export const FULL_PRECISION_BITS = 32;
export const DEFAULT_POSITION_SECS = 30;
/** How often the board reads its GPS. Meshtastic's default is 120 s, too slow to keep up with 30 s reports. */
export const DEFAULT_GPS_UPDATE_SECS = 15;
export const POSITION_SECS_MIN = 15;
export const POSITION_SECS_MAX = 3600;
/** Meshtastic's default preset, so a board that was never set up still matches. */
export const TEAM_PRESET = Protobuf.Config.Config_LoRaConfig_ModemPreset.LONG_FAST;
export const DEFAULT_REGION = Protobuf.Config.Config_LoRaConfig_RegionCode.US;

/** Regions the setup screen offers, as Meshtastic names them. */
export const REGIONS: Array<{ code: number; name: string }> = Object.entries(
  Protobuf.Config.Config_LoRaConfig_RegionCode,
)
  .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] !== 0)
  .map(([name, code]) => ({ code, name }));

export function regionName(code: number | null): string {
  if (code == null) return "unknown";
  return Protobuf.Config.Config_LoRaConfig_RegionCode[code] ?? String(code);
}

export function presetName(code: number | null): string {
  if (code == null) return "unknown";
  return Protobuf.Config.Config_LoRaConfig_ModemPreset[code] ?? String(code);
}

/** What "Set up this board" writes. The same plan goes on every board in the team. */
export interface BoardPlan {
  channelName: string;
  /** AES key for the team channel, 16 or 32 bytes. */
  key: Uint8Array;
  positionSecs: number;
  gpsUpdateSecs: number;
  /** GPIO for the OK button, or null to leave the Detection Sensor module alone. */
  okButtonPin: number | null;
  /** LoRa region code. Every board must match, and UNSET keeps the radio off. */
  region: number;
}

/** The settings that matter here, as the connected board reports them. */
export interface BoardSettings {
  channelName: string | null;
  keyBase64: string | null;
  precisionBits: number | null;
  positionSecs: number | null;
  smartPosition: boolean | null;
  gpsUpdateSecs: number | null;
  /** Null when the Detection Sensor module is off. */
  okButtonPin: number | null;
  okButtonName: string | null;
  /** LoRa region. 0 (UNSET) means the radio is off. */
  region: number | null;
  /** Preset in use, or null when the board uses custom radio settings. */
  modemPreset: number | null;
  txEnabled: boolean | null;
}

/** The board's own settings, read during configure. A write replaces a whole group, so these are the base. */
export interface CurrentBoardConfig {
  channel?: Protobuf.Channel.Channel;
  position?: Protobuf.Config.Config_PositionConfig;
  detection?: Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfig;
  lora?: Protobuf.Config.Config_LoRaConfig;
}

export interface BoardWrites {
  channel: Protobuf.Channel.Channel;
  position: Protobuf.Config.Config;
  lora: Protobuf.Config.Config;
  detection: Protobuf.ModuleConfig.ModuleConfig | null;
}

/**
 * The three settings writes for a plan, each built on the board's current values.
 * Meshtastic replaces a whole settings group on each write, and a missing field means its zero value.
 * For position that zero value is GPS disabled, so every field not named here is copied from the board.
 */
export function buildBoardWrites(current: CurrentBoardConfig, plan: BoardPlan): BoardWrites {
  if (!current.position || !current.lora) {
    throw new Error("Still reading this board's settings. Try again in a few seconds.");
  }
  const problem = checkPlan(plan);
  if (problem) throw new Error(problem);

  const channel = create(Protobuf.Channel.ChannelSchema, {
    index: 0,
    role: Protobuf.Channel.Channel_Role.PRIMARY,
    settings: create(Protobuf.Channel.ChannelSettingsSchema, {
      name: plan.channelName.trim(),
      psk: plan.key,
      id: current.channel?.settings?.id ?? 0,
      uplinkEnabled: false,
      downlinkEnabled: false,
      moduleSettings: create(Protobuf.Channel.ModuleSettingsSchema, {
        positionPrecision: FULL_PRECISION_BITS,
        isMuted: false,
      }),
    }),
  });

  const positionConfig = clone(Protobuf.Config.Config_PositionConfigSchema, current.position);
  positionConfig.positionBroadcastSecs = Math.round(plan.positionSecs);
  positionConfig.positionBroadcastSmartEnabled = false;
  positionConfig.gpsUpdateInterval = Math.round(plan.gpsUpdateSecs);
  positionConfig.fixedPosition = false;
  if (positionConfig.gpsMode === Protobuf.Config.Config_PositionConfig_GpsMode.DISABLED) {
    positionConfig.gpsMode = Protobuf.Config.Config_PositionConfig_GpsMode.ENABLED;
  }
  const position = create(Protobuf.Config.ConfigSchema, {
    payloadVariant: { case: "position", value: positionConfig },
  });

  // Same region and preset on every board, so they share one frequency. The frequency slot
  // comes from the channel name, which is also the same on every board.
  const loraConfig = clone(Protobuf.Config.Config_LoRaConfigSchema, current.lora);
  loraConfig.region = plan.region;
  loraConfig.usePreset = true;
  loraConfig.modemPreset = TEAM_PRESET;
  loraConfig.channelNum = 0;
  loraConfig.txEnabled = true;
  const lora = create(Protobuf.Config.ConfigSchema, {
    payloadVariant: { case: "lora", value: loraConfig },
  });

  let detection: Protobuf.ModuleConfig.ModuleConfig | null = null;
  if (plan.okButtonPin != null) {
    const sensor = current.detection
      ? clone(Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfigSchema, current.detection)
      : create(Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfigSchema);
    sensor.enabled = true;
    sensor.monitorPin = plan.okButtonPin;
    sensor.name = "OK";
    sensor.detectionTriggerType = Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfig_TriggerType.FALLING_EDGE;
    sensor.usePullup = true;
    sensor.minimumBroadcastSecs = 5;
    // 0 turns off the periodic state message, so the board never sends OK without a press.
    sensor.stateBroadcastSecs = 0;
    sensor.sendBell = false;
    detection = create(Protobuf.ModuleConfig.ModuleConfigSchema, {
      payloadVariant: { case: "detectionSensor", value: sensor },
    });
  }

  return { channel, position, lora, detection };
}

/** A message for the first problem with a plan, or null when it is usable. */
export function checkPlan(plan: BoardPlan): string | null {
  const name = plan.channelName.trim();
  if (!name) return "Enter a team channel name.";
  if (new TextEncoder().encode(name).length > CHANNEL_NAME_MAX) {
    return `The channel name must be ${CHANNEL_NAME_MAX} characters or fewer.`;
  }
  if (plan.key.length !== 16 && plan.key.length !== 32) return "The team key is not valid. Generate a new one.";
  if (!Number.isFinite(plan.positionSecs) || plan.positionSecs < POSITION_SECS_MIN || plan.positionSecs > POSITION_SECS_MAX) {
    return `Position interval must be ${POSITION_SECS_MIN}–${POSITION_SECS_MAX} s.`;
  }
  if (!plan.region) return "Choose the region your boards are used in.";
  if (plan.okButtonPin != null && (!Number.isInteger(plan.okButtonPin) || plan.okButtonPin < 0 || plan.okButtonPin > 48)) {
    return "The OK button pin must be a GPIO number from 0 to 48.";
  }
  if (plan.okButtonPin != null && RESERVED_PINS.has(plan.okButtonPin)) {
    return `GPIO ${plan.okButtonPin} is already used on the Heltec V4 (${RESERVED_PINS.get(plan.okButtonPin)}). Pick another pin.`;
  }
  return null;
}

/** Pins the stock firmware already drives on the Heltec V4. Not a complete pinout: check before wiring. */
const RESERVED_PINS = new Map<number, string>([
  [0, "PRG button"],
  [38, "GPS"],
  [39, "GPS"],
]);

/** The parts of the board's settings the setup screen compares against the team plan. */
export function summarize(current: CurrentBoardConfig): BoardSettings {
  const settings = current.channel?.settings;
  const sensor = current.detection;
  return {
    channelName: settings ? settings.name : null,
    keyBase64: settings ? bytesToBase64(settings.psk) : null,
    precisionBits: settings ? (settings.moduleSettings?.positionPrecision ?? 0) : null,
    positionSecs: current.position ? current.position.positionBroadcastSecs : null,
    smartPosition: current.position ? current.position.positionBroadcastSmartEnabled : null,
    gpsUpdateSecs: current.position ? current.position.gpsUpdateInterval : null,
    okButtonPin: sensor?.enabled ? sensor.monitorPin : null,
    okButtonName: sensor?.enabled ? sensor.name : null,
    region: current.lora ? current.lora.region : null,
    modemPreset: current.lora ? (current.lora.usePreset ? current.lora.modemPreset : null) : null,
    txEnabled: current.lora ? current.lora.txEnabled : null,
  };
}

/** What still differs from the plan, in words. Empty when the board matches. */
export function differences(board: BoardSettings, plan: BoardPlan): string[] {
  const out: string[] = [];
  if (board.channelName == null || board.positionSecs == null || board.region == null) {
    return ["Still reading this board's settings"];
  }
  if (board.region === 0) out.push("Region is not set, so its radio is off");
  else if (board.region !== plan.region) out.push(`Region is ${regionName(board.region)}`);
  if (board.modemPreset !== TEAM_PRESET) {
    out.push(board.modemPreset == null ? "Uses custom radio settings" : `Preset is ${presetName(board.modemPreset)}`);
  }
  if (board.txEnabled === false) out.push("Transmit is turned off");
  if (board.channelName !== plan.channelName.trim()) out.push(`Channel is "${board.channelName || "default"}"`);
  if (board.keyBase64 !== bytesToBase64(plan.key)) out.push("Channel key is not the team key");
  if (board.precisionBits !== FULL_PRECISION_BITS) out.push("Position precision is reduced");
  if (board.positionSecs !== Math.round(plan.positionSecs)) out.push(`Position every ${board.positionSecs || "default"} s`);
  if (board.smartPosition) out.push("Smart position is on");
  if (plan.okButtonPin != null && board.okButtonPin !== plan.okButtonPin) {
    out.push(board.okButtonPin == null ? "OK button is off" : `OK button is on GPIO ${board.okButtonPin}`);
  }
  return out;
}

export function generateKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Null when the text is not base64 for a 16- or 32-byte key. */
export function base64ToKey(text: string): Uint8Array | null {
  try {
    const binary = atob(text.trim());
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return bytes.length === 16 || bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
