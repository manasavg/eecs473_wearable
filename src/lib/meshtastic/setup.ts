import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Protobuf as LibraryProtobuf } from "@meshtastic/core";
import * as Protobuf from "@meshtastic/protobufs";

/*
 * Settings are built and sent with @meshtastic/protobufs, not with the copy bundled inside
 * @meshtastic/core. That copy is older: it has no deviceTelemetryEnabled, for one, and
 * serializing through it silently drops every field it does not know. Messages the library
 * decoded are converted with toCurrent before use, so newer fields the board sent survive.
 */

/** Re-read a message the library decoded with its older bundled schema, keeping every field. */
function toCurrent<Old extends Parameters<typeof toBinary>[1], New extends Parameters<typeof fromBinary>[0]>(
  oldSchema: Parameters<typeof toBinary>[0],
  newSchema: New,
  message: Old | undefined,
) {
  if (!message) return undefined;
  return fromBinary(newSchema, toBinary(oldSchema, message));
}

/** The board's settings, converted from the library's bundled schema to the current one. */
export function currentBoardConfig(raw: {
  channel?: LibraryProtobuf.Channel.Channel;
  position?: LibraryProtobuf.Config.Config_PositionConfig;
  detection?: LibraryProtobuf.ModuleConfig.ModuleConfig_DetectionSensorConfig;
  lora?: LibraryProtobuf.Config.Config_LoRaConfig;
  telemetry?: LibraryProtobuf.ModuleConfig.ModuleConfig_TelemetryConfig;
}): CurrentBoardConfig {
  return {
    channel: toCurrent(LibraryProtobuf.Channel.ChannelSchema, Protobuf.Channel.ChannelSchema, raw.channel),
    position: toCurrent(
      LibraryProtobuf.Config.Config_PositionConfigSchema,
      Protobuf.Config.Config_PositionConfigSchema,
      raw.position,
    ),
    detection: toCurrent(
      LibraryProtobuf.ModuleConfig.ModuleConfig_DetectionSensorConfigSchema,
      Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfigSchema,
      raw.detection,
    ),
    lora: toCurrent(LibraryProtobuf.Config.Config_LoRaConfigSchema, Protobuf.Config.Config_LoRaConfigSchema, raw.lora),
    telemetry: toCurrent(
      LibraryProtobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema,
      Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema,
      raw.telemetry,
    ),
  };
}

/** One admin message for the connected board, serialized with the current schema. */
export function adminBytes(payloadVariant: Protobuf.Admin.AdminMessage["payloadVariant"]): Uint8Array {
  return toBinary(Protobuf.Admin.AdminMessageSchema, create(Protobuf.Admin.AdminMessageSchema, { payloadVariant }));
}

/** Meshtastic channel names must fit in 11 bytes. */
export const CHANNEL_NAME_MAX = 11;
/** 32 is full precision. 0 would stop sharing positions on the channel. */
export const FULL_PRECISION_BITS = 32;
export const DEFAULT_POSITION_SECS = 30;
/** How often the board reads its GPS. Meshtastic's default is 120 s, too slow to keep up with 30 s reports. */
export const DEFAULT_GPS_UPDATE_SECS = 15;
export const POSITION_SECS_MIN = 15;
/**
 * Battery report interval. It goes out with or without a GPS fix, so it is the heartbeat
 * that keeps a board from looking lost indoors.
 */
export const DEFAULT_HEARTBEAT_SECS = 60;
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
  /** How often the board reports its battery over the radio. Optional for older saved plans. */
  heartbeatSecs?: number;
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
  /** Battery report interval, or 0 when the board does not send it over the radio. Null until read. */
  heartbeatSecs: number | null;
}

/** The board's own settings, read during configure. A write replaces a whole group, so these are the base. */
export interface CurrentBoardConfig {
  channel?: Protobuf.Channel.Channel;
  position?: Protobuf.Config.Config_PositionConfig;
  detection?: Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfig;
  lora?: Protobuf.Config.Config_LoRaConfig;
  telemetry?: Protobuf.ModuleConfig.ModuleConfig_TelemetryConfig;
}

export interface BoardWrites {
  channel: Protobuf.Channel.Channel;
  position: Protobuf.Config.Config;
  lora: Protobuf.Config.Config;
  telemetry: Protobuf.ModuleConfig.ModuleConfig;
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

  const telemetryConfig = current.telemetry
    ? clone(Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema, current.telemetry)
    : create(Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema);
  telemetryConfig.deviceTelemetryEnabled = true;
  telemetryConfig.deviceUpdateInterval = Math.round(plan.heartbeatSecs ?? DEFAULT_HEARTBEAT_SECS);
  const telemetry = create(Protobuf.ModuleConfig.ModuleConfigSchema, {
    payloadVariant: { case: "telemetry", value: telemetryConfig },
  });

  let detection: Protobuf.ModuleConfig.ModuleConfig | null = null;
  if (plan.okButtonPin != null) {
    const sensor = current.detection
      ? clone(Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfigSchema, current.detection)
      : create(Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfigSchema);
    sensor.enabled = true;
    sensor.monitorPin = plan.okButtonPin;
    sensor.name = "OK";
    // Either edge: the board reports the press and the release, so the app can time a hold
    // for the emergency alert. Active low: pressed joins the pin to GND.
    sensor.detectionTriggerType =
      Protobuf.ModuleConfig.ModuleConfig_DetectionSensorConfig_TriggerType.EITHER_EDGE_ACTIVE_LOW;
    sensor.usePullup = true;
    // Short, so the release of a 3 s hold is not held back behind the press.
    sensor.minimumBroadcastSecs = 1;
    // 0 turns off the periodic state message, so the board never sends OK without a press.
    sensor.stateBroadcastSecs = 0;
    sensor.sendBell = false;
    detection = create(Protobuf.ModuleConfig.ModuleConfigSchema, {
      payloadVariant: { case: "detectionSensor", value: sensor },
    });
  }

  return { channel, position, lora, telemetry, detection };
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

/**
 * Pins the Heltec V3/V4 or the ESP32-S3 already use. Not a complete pinout: check the V4 pinout before wiring.
 * Likely free on the header: 2, 4, 5, 6, 7, 40, 41, 42, 47, 48.
 */
const RESERVED_PINS = new Map<number, string>([
  [0, "PRG button"],
  [1, "battery sense"],
  [3, "an ESP32-S3 boot pin"],
  [8, "LoRa radio"],
  [9, "LoRa radio"],
  [10, "LoRa radio"],
  [11, "LoRa radio"],
  [12, "LoRa radio"],
  [13, "LoRa radio"],
  [14, "LoRa radio"],
  [17, "the screen"],
  [18, "the screen"],
  [19, "USB"],
  [20, "USB"],
  [21, "the screen"],
  [26, "flash memory"],
  [27, "flash memory"],
  [28, "flash memory"],
  [29, "flash memory"],
  [30, "flash memory"],
  [31, "flash memory"],
  [32, "flash memory"],
  [33, "PSRAM on R8 boards"],
  [34, "PSRAM on R8 boards"],
  [35, "the LED"],
  [36, "board power control"],
  [37, "PSRAM on R8 boards"],
  [38, "GPS"],
  [39, "GPS"],
  [45, "an ESP32-S3 boot pin"],
  [46, "an ESP32-S3 boot pin"],
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
    heartbeatSecs: current.telemetry
      ? current.telemetry.deviceTelemetryEnabled
        ? current.telemetry.deviceUpdateInterval
        : 0
      : null,
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
  const heartbeat = Math.round(plan.heartbeatSecs ?? DEFAULT_HEARTBEAT_SECS);
  if (board.heartbeatSecs != null && board.heartbeatSecs !== heartbeat) {
    out.push(
      board.heartbeatSecs === 0
        ? "Battery reports are not sent over the radio"
        : `Battery report every ${board.heartbeatSecs || "default"} s`,
    );
  }
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
