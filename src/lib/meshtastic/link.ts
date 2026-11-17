import { fromBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf } from "@meshtastic/core";
import type { BleEvent } from "../ble/transport";
import { adminBytes, buildBoardWrites, currentBoardConfig, summarize, type BoardPlan } from "./setup";

const FIRST_NODE = 4;
const REAL_TIME_SEC = 1_600_000_000;
const QUIET_MS = 6 * 60 * 60 * 1000;
/** Boards farther than this many relays away are not part of the group. */
const MAX_HOPS = 2;
/** A Bluetooth write that has not finished by now is treated as failed. */
const WRITE_TIMEOUT_MS = 10_000;

/** Routing errors that mean the board never answered, as opposed to a setup problem. */
const NO_ANSWER_ERRORS = new Set<number>([
  Protobuf.Mesh.Routing_Error.TIMEOUT,
  Protobuf.Mesh.Routing_Error.MAX_RETRANSMIT,
  Protobuf.Mesh.Routing_Error.NO_RESPONSE,
]);

interface HeardNode {
  name: string;
  fix: boolean;
  lat: number | null;
  lon: number | null;
}

interface WriteWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * The phone's connection to one Heltec, using Meshtastic's own client.
 * This file only moves that client's events into the dashboard.
 * The radio already owns LoRa, GPS, and the node database.
 */
export class MeshLink {
  readonly device: MeshDevice;
  private readonly onEvent: (event: BleEvent) => void;
  private readonly pushPacket: (bytes: Uint8Array) => void;
  private myNode = 0;
  private readonly nodes = new Map<number, HeardNode>();
  /** Never shown: heard over MQTT, ignored on the radio, or too many hops away. */
  private readonly rejected = new Set<number>();
  /** Not heard for hours when the database was read. Cleared as soon as the board is heard again. */
  private readonly stale = new Set<number>();
  private writeWaiters: WriteWaiter[] = [];
  /**
   * Check-in packet id → the board it was sent to. The transport passes the same map to the
   * link it builds after a reconnect, so an answer that arrives after the drop still counts.
   */
  private readonly pending: Map<number, number>;
  /** Set by the radio's echo of a text this phone just sent. */
  private echoedTextId: number | null = null;
  /** The connected board's own settings, as configure reports them. */
  private readonly boardConfig: Parameters<typeof currentBoardConfig>[0] = {};

  constructor(
    write: (bytes: Uint8Array) => Promise<void>,
    onEvent: (event: BleEvent) => void,
    pending: Map<number, number> = new Map(),
  ) {
    this.onEvent = onEvent;
    this.pending = pending;
    let controller: ReadableStreamDefaultController<{ type: "packet"; data: Uint8Array }> | null = null;
    const fromDevice = new ReadableStream<{ type: "packet"; data: Uint8Array }>({
      start: (stream) => {
        controller = stream;
      },
    });
    const toDevice = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        const waiting = this.writeWaiters;
        this.writeWaiters = [];
        try {
          await write(bytes);
        } catch (error) {
          // Tell the caller, but do not throw: a throwing sink errors this stream for good,
          // and every later message to the board would fail with it.
          const failure = error instanceof Error ? error : new Error("The write to the board failed.");
          for (const waiter of waiting) waiter.reject(failure);
          return;
        }
        for (const waiter of waiting) waiter.resolve();
      },
    });
    this.pushPacket = (bytes) => controller?.enqueue({ type: "packet", data: bytes });
    this.device = new MeshDevice({
      fromDevice,
      toDevice,
      disconnect: async () => undefined,
    });
    this.device.events.onMyNodeInfo.subscribe((info: Protobuf.Mesh.MyNodeInfo) => {
      this.myNode = info.myNodeNum >>> 0;
      this.emit({ type: "my-node", id: this.myNode });
      if (this.nodes.delete(this.myNode)) this.emit(live({ followerGoneId: this.myNode }));
    });
    this.device.events.onNodeInfoPacket.subscribe((info: Protobuf.Mesh.NodeInfo) => {
      this.onNode(info);
    });
    this.device.events.onChannelPacket.subscribe((channel: Protobuf.Channel.Channel) => {
      if (channel.index !== 0) return;
      this.boardConfig.channel = channel;
      this.emitBoardSettings();
    });
    this.device.events.onConfigPacket.subscribe((config: Protobuf.Config.Config) => {
      if (config.payloadVariant.case === "position") this.boardConfig.position = config.payloadVariant.value;
      else if (config.payloadVariant.case === "lora") this.boardConfig.lora = config.payloadVariant.value;
      else return;
      this.emitBoardSettings();
    });
    this.device.events.onModuleConfigPacket.subscribe((config: Protobuf.ModuleConfig.ModuleConfig) => {
      if (config.payloadVariant.case === "detectionSensor") this.boardConfig.detection = config.payloadVariant.value;
      else if (config.payloadVariant.case === "telemetry") this.boardConfig.telemetry = config.payloadVariant.value;
      else return;
      this.emitBoardSettings();
    });
    this.device.events.onMeshPacket.subscribe((packet: Protobuf.Mesh.MeshPacket) => {
      this.onMeshPacket(packet);
    });
    this.device.events.onPositionPacket.subscribe((packet: { from: number; data: Protobuf.Mesh.Position }) => {
      const now = Date.now();
      this.onPosition(packet.from >>> 0, packet.data, now, undefined);
    });
    this.device.events.onUserPacket.subscribe((packet: { from: number; data: Protobuf.Mesh.User }) => {
      this.onUser(packet.from >>> 0, packet.data, Date.now());
    });
    this.device.events.onMessagePacket.subscribe((packet: { from: number; data: string }) => {
      const from = packet.from >>> 0;
      if (from === this.myNode || from < FIRST_NODE) return;
      // Drop control characters, such as the bell the Detection Sensor module can add.
      const text = packet.data.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (!text) return;
      this.emit(live({ text, fromId: from, okId: isOkText(text) ? from : null }));
    });
    // Battery reports. They double as the heartbeat; onHeard already counts the packet.
    this.device.events.onTelemetryPacket.subscribe(
      (packet: { from: number; data: Protobuf.Telemetry.Telemetry }) => {
        if (packet.data.variant.case !== "deviceMetrics") return;
        const metrics = packet.data.variant.value;
        const from = packet.from >>> 0;
        if (from !== this.myNode && (from < FIRST_NODE || this.rejected.has(from))) return;
        this.emit({
          type: "battery",
          id: from,
          percent: metrics.batteryLevel ?? null,
          voltage: metrics.voltage ?? null,
        });
      },
    );
    // The OK button: Meshtastic's Detection Sensor module sends "<name> detected" as its own
    // message type, not as a text message, so it never reaches onMessagePacket.
    // Any detection from a follower is a press, whatever name the module was given.
    this.device.events.onDetectionSensorPacket.subscribe((packet: { from: number; data: Uint8Array }) => {
      const from = packet.from >>> 0;
      if (from === this.myNode || from < FIRST_NODE || this.rejected.has(from)) return;
      const text = new TextDecoder().decode(packet.data).replace(/[\u0000-\u001f\u007f]/g, "").trim();
      this.emit({ type: "ok-press", id: from, text: text || "button pressed" });
    });
  }

  /** One FromRadio protobuf from the radio's queue. */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.pushPacket(bytes);
  }

  /** Ask Meshtastic to send its node database. Resolves once that request is written. */
  async configure(): Promise<void> {
    const written = this.whenWritten();
    void this.device.configure().catch(() => undefined);
    await written;
  }

  /** The boards this radio is tracking, in node-number order. */
  knownNodes(): number[] {
    return [...this.nodes.keys()].sort((a, b) => a - b);
  }

  /**
   * Meshtastic text CHECK IN to one board, with an acknowledgement requested.
   * Resolves with the packet id once it is written to the leader.
   * The answer arrives later as a checkin-ack or checkin-failed event.
   */
  async sendCheckIn(target: number): Promise<number> {
    const written = this.whenWritten();
    this.echoedTextId = null;
    const sending = this.device.sendText("CHECK IN", target >>> 0, true);
    const packetId = this.echoedTextId as number | null;
    this.echoedTextId = null;
    if (packetId == null) {
      void sending.catch(() => undefined);
      throw new Error("The leader board is not ready for a check-in yet.");
    }
    this.pending.set(packetId, target >>> 0);
    this.emit({ type: "checkin-sent", id: target >>> 0, packetId });
    sending.catch((error: unknown) => {
      const code = routingErrorCode(error);
      this.fail(packetId, code ?? Protobuf.Mesh.Routing_Error.TIMEOUT);
    });
    try {
      await written;
    } catch (error) {
      this.pending.delete(packetId);
      throw error;
    }
    return packetId;
  }

  /**
   * Write the team channel, position reporting, and OK button to the connected board.
   * Each write is built on the board's current settings. The board may reboot to apply them,
   * which drops the Bluetooth link; the transport then reconnects.
   */
  async setUpBoard(plan: BoardPlan): Promise<"confirmed" | "restarting"> {
    const writes = buildBoardWrites(currentBoardConfig(this.boardConfig), plan);
    // Sent as raw admin messages, not with device.setConfig and friends: those serialize with
    // the library's older bundled schema, which drops newer fields. See setup.ts.
    // Everything between begin and commit is applied together on commit.
    await setupStep("edit session", this.sendAdmin({ case: "beginEditSettings", value: true }));
    await setupStep("position settings", this.sendAdmin({ case: "setConfig", value: writes.position }));
    await setupStep("radio region and preset", this.sendAdmin({ case: "setConfig", value: writes.lora }));
    await setupStep("team channel", this.sendAdmin({ case: "setChannel", value: writes.channel }));
    await setupStep("battery report heartbeat", this.sendAdmin({ case: "setModuleConfig", value: writes.telemetry }));
    if (writes.detection) {
      await setupStep("OK button", this.sendAdmin({ case: "setModuleConfig", value: writes.detection }));
    }
    // Changing the region makes the board restart to apply it, and it may restart before it
    // acknowledges the commit. A missing answer here is not a failure: the app reconnects
    // and Board setup shows whether the board now matches.
    try {
      await withTimeout(this.sendAdmin({ case: "commitEditSettings", value: true }), COMMIT_WAIT_MS);
      return "confirmed";
    } catch (error) {
      const code = routingErrorCode(error);
      if (code == null || NO_ANSWER_ERRORS.has(code)) return "restarting";
      throw new Error(`The board refused to save the settings (${routingErrorText(code)}).`);
    }
  }

  private emitBoardSettings(): void {
    this.emit({ type: "board-settings", settings: summarize(currentBoardConfig(this.boardConfig)) });
  }

  /** An admin message to the connected board, acknowledged by the board itself. */
  private sendAdmin(payloadVariant: Parameters<typeof adminBytes>[0]): Promise<number> {
    return this.device.sendPacket(adminBytes(payloadVariant), Protobuf.Portnums.PortNum.ADMIN_APP, "self");
  }

  private whenWritten(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.writeWaiters = this.writeWaiters.filter((item) => item !== waiter);
        reject(new Error("The leader board did not take the message. Move closer and try again."));
      }, WRITE_TIMEOUT_MS);
      const waiter: WriteWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.writeWaiters.push(waiter);
    });
  }

  private onMeshPacket(packet: Protobuf.Mesh.MeshPacket): void {
    const from = packet.from >>> 0;
    const decoded = packet.payloadVariant.case === "decoded" ? packet.payloadVariant.value : null;

    if (from === this.myNode) {
      // The client echoes each text it sends. That echo carries the packet id.
      if (decoded?.portnum === Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP) {
        this.echoedTextId = packet.id >>> 0;
      }
    } else if (from >= FIRST_NODE && this.myNode !== 0) {
      this.onHeard(from, packet);
    }

    if (decoded?.portnum !== Protobuf.Portnums.PortNum.ROUTING_APP) return;
    const requestId = decoded.requestId >>> 0;
    const target = this.pending.get(requestId);
    if (target == null) return;
    let routing: Protobuf.Mesh.Routing;
    try {
      routing = fromBinary(Protobuf.Mesh.RoutingSchema, decoded.payload);
    } catch {
      return;
    }
    if (routing.variant.case !== "errorReason") return;
    if (routing.variant.value === Protobuf.Mesh.Routing_Error.NONE) {
      // An acknowledgement from the leader itself only means another radio repeated it.
      // Only the target's own acknowledgement means the target got it.
      if (from !== target) return;
      this.pending.delete(requestId);
      this.emit({ type: "checkin-ack", id: target, packetId: requestId });
      return;
    }
    this.fail(requestId, routing.variant.value);
  }

  private fail(packetId: number, code: number): void {
    const target = this.pending.get(packetId);
    if (target == null) return;
    this.pending.delete(packetId);
    this.emit({
      type: "checkin-failed",
      id: target,
      packetId,
      noAnswer: NO_ANSWER_ERRORS.has(code),
      reason: routingErrorText(code),
    });
  }

  /**
   * Any packet from another board. A board without a GPS fix sends no position,
   * so this is often the first sign of it: add it then instead of waiting hours for its name.
   */
  private onHeard(from: number, packet: Protobuf.Mesh.MeshPacket): void {
    if (this.rejected.has(from)) return;
    if (packet.viaMqtt) return;
    const hops = packet.hopStart > 0 ? packet.hopStart - packet.hopLimit : 0;
    if (hops > MAX_HOPS) return;
    this.stale.delete(from);
    const now = Date.now();
    if (!this.nodes.has(from)) {
      const node: HeardNode = { name: nodeName(undefined, from), fix: false, lat: null, lon: null };
      this.nodes.set(from, node);
      this.emit({ type: "node-seen", id: from, name: node.name, at: now });
      return;
    }
    this.emit({ type: "heard", id: from, at: now });
  }

  private onNode(info: Protobuf.Mesh.NodeInfo): void {
    const id = info.num >>> 0;
    const heardAt = info.lastHeard > REAL_TIME_SEC ? Math.min(info.lastHeard * 1000, Date.now()) : null;
    if (info.viaMqtt || info.isIgnored || (info.hopsAway ?? 0) > MAX_HOPS) {
      this.rejected.add(id);
      if (this.nodes.delete(id)) this.emit(live({ followerGoneId: id }));
      return;
    }
    this.rejected.delete(id);
    if (heardAt != null && Date.now() - heardAt > QUIET_MS) {
      this.stale.add(id);
      if (this.nodes.delete(id)) this.emit(live({ followerGoneId: id }));
      return;
    }
    const name = nodeName(info.user, id);
    if (info.position) this.onPosition(id, info.position, heardAt, name);
    else if (info.user) this.onUser(id, info.user, heardAt);
    else if (id >= FIRST_NODE && id !== this.myNode) {
      // In the database but never sent its name: still a board this radio heard.
      this.nodes.set(id, { name, fix: false, lat: null, lon: null });
      this.emit({ type: "node-seen", id, name, at: heardAt });
    }
  }

  private onPosition(
    id: number,
    position: Protobuf.Mesh.Position,
    heardAt: number | null,
    name: string | undefined,
  ): void {
    if (id < FIRST_NODE || this.rejected.has(id) || this.stale.has(id)) return;
    const fix = readFix(position);
    const positionAt = positionTime(position, heardAt);
    if (id === this.myNode) {
      this.emit(live({ gps: { ...fix, at: positionAt } }));
      return;
    }
    const previous = this.nodes.get(id);
    const node: HeardNode = {
      name: name || previous?.name || nodeName(undefined, id),
      ...fix,
    };
    this.nodes.set(id, node);
    this.emit(followerEvent(id, node, heardAt, positionAt));
  }

  private onUser(id: number, user: Protobuf.Mesh.User | undefined, heardAt: number | null): void {
    if (id < FIRST_NODE || id === this.myNode || this.rejected.has(id) || this.stale.has(id) || !user) return;
    const previous = this.nodes.get(id);
    const node: HeardNode = {
      name: nodeName(user, id),
      fix: previous?.fix ?? false,
      lat: previous?.lat ?? null,
      lon: previous?.lon ?? null,
    };
    this.nodes.set(id, node);
    this.emit(followerEvent(id, node, heardAt, undefined));
  }

  private emit(event: BleEvent): void {
    this.onEvent(event);
  }
}

function followerEvent(
  id: number,
  node: HeardNode,
  heardAt: number | null,
  positionAt: number | null | undefined,
): BleEvent {
  return live({
    followerGps: {
      id,
      fix: node.fix,
      lat: node.lat,
      lon: node.lon,
      name: node.name,
      heardAt,
      ...(positionAt !== undefined ? { positionAt } : {}),
    },
  });
}

function live(partial: Partial<Extract<BleEvent, { type: "live" }>>): BleEvent {
  return { type: "live", counter: null, text: null, hex: "", ...partial };
}

function nodeName(user: Protobuf.Mesh.User | undefined, id: number): string {
  const longName = user?.longName?.trim();
  const shortName = user?.shortName?.trim();
  if (longName) return longName;
  if (shortName) return shortName;
  return `Meshtastic ${(id >>> 0).toString(16).slice(-4).toUpperCase()}`;
}

/** When the board took this position: its own GPS time when set, else when it was heard. */
function positionTime(position: Protobuf.Mesh.Position, heardAt: number | null): number | null {
  if (position.time > REAL_TIME_SEC) return Math.min(position.time * 1000, Date.now());
  return heardAt;
}

function readFix(position: Protobuf.Mesh.Position): { fix: boolean; lat: number | null; lon: number | null } {
  const latI = position.latitudeI;
  const lonI = position.longitudeI;
  if (latI == null || lonI == null || (latI === 0 && lonI === 0)) {
    return { fix: false, lat: null, lon: null };
  }
  const lat = latI / 1e7;
  const lon = lonI / 1e7;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { fix: false, lat: null, lon: null };
  return { fix: true, lat, lon };
}

/** How long each settings write may take before setup reports which one failed. */
const SETUP_STEP_MS = 20_000;
const COMMIT_WAIT_MS = 10_000;

/** Run one settings write. Meshtastic rejects with a plain object, so turn that into a readable error. */
async function setupStep(what: string, sending: Promise<number>): Promise<void> {
  try {
    await withTimeout(sending, SETUP_STEP_MS);
  } catch (error) {
    const code = routingErrorCode(error);
    if (code != null) {
      throw new Error(`The board did not accept the ${what}: ${routingErrorText(code)}.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The board did not accept the ${what}: ${detail}.`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject({ error: Protobuf.Mesh.Routing_Error.TIMEOUT }),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A text reply that means OK: it starts with the word OK, such as "OK" or "OK detected".
 * Not OK anywhere, so "not ok" does not confirm a check-in. The button sends its own
 * message type, handled in onDetectionSensorPacket.
 */
export function isOkText(text: string): boolean {
  return /^OK\b/i.test(text.trim());
}

function routingErrorCode(error: unknown): number | null {
  if (error && typeof error === "object" && "error" in error) {
    const code = (error as { error: unknown }).error;
    if (typeof code === "number") return code;
  }
  return null;
}

function routingErrorText(code: number): string {
  switch (code) {
    case Protobuf.Mesh.Routing_Error.TIMEOUT:
    case Protobuf.Mesh.Routing_Error.MAX_RETRANSMIT:
    case Protobuf.Mesh.Routing_Error.NO_RESPONSE:
      return "No answer";
    case Protobuf.Mesh.Routing_Error.NO_ROUTE:
      return "No route to that board";
    case Protobuf.Mesh.Routing_Error.DUTY_CYCLE_LIMIT:
      return "Radio is over its airtime limit. Wait and try again.";
    case Protobuf.Mesh.Routing_Error.PKI_FAILED:
    case Protobuf.Mesh.Routing_Error.PKI_UNKNOWN_PUBKEY:
      return "That board's encryption key is unknown";
    default:
      return `Not delivered (${Protobuf.Mesh.Routing_Error[code] ?? code})`;
  }
}
