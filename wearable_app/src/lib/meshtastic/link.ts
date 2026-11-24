import { fromBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf } from "@meshtastic/core";
import { MESH_BROADCAST_ID } from "../ble/constants";
import type { BleEvent } from "../ble/transport";

const FIRST_NODE = 4;
const REAL_TIME_SEC = 1_600_000_000;
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
  private readonly lastPositionAt = new Map<number, number>();
  private readonly nodes = new Map<number, HeardNode>();
  private readonly ignored = new Set<number>();
  private readonly nodesBeforeIdentity: Protobuf.Mesh.NodeInfo[] = [];
  private writeWaiters: WriteWaiter[] = [];
  /**
   * Check-in packet id → the board it was sent to. The transport passes the same map to the
   * link it builds after a reconnect, so an answer that arrives after the drop still counts.
   */
  private readonly pending: Map<number, number>;
  /** Set by the radio's echo of a text this phone just sent. */
  private echoedTextId: number | null = null;

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
      for (const node of this.nodesBeforeIdentity.splice(0)) this.onNode(node);
    });
    this.device.events.onNodeInfoPacket.subscribe((info: Protobuf.Mesh.NodeInfo) => {
      this.onNode(info);
    });
    this.device.events.onMeshPacket.subscribe((packet: Protobuf.Mesh.MeshPacket) => {
      this.onMeshPacket(packet);
    });
    // Battery reports. They double as the heartbeat; onHeard already counts the packet.
    this.device.events.onTelemetryPacket.subscribe(
      (packet: { from: number; data: Protobuf.Telemetry.Telemetry }) => {
        if (packet.data.variant.case !== "deviceMetrics") return;
        const metrics = packet.data.variant.value;
        const from = packet.from >>> 0;
        if (from !== this.myNode && (from < FIRST_NODE || this.ignored.has(from))) return;
        // A board with no battery sense pin reports 0 % at 0 V. That is unknown, not empty.
        const unknown = !metrics.batteryLevel && !metrics.voltage;
        this.emit({
          type: "battery",
          id: from,
          percent: unknown ? null : (metrics.batteryLevel ?? null),
          voltage: metrics.voltage ?? null,
        });
      },
    );
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

  /**
   * Meshtastic text CHECK IN to one board, with an acknowledgement requested.
   * Resolves with the packet id once it is written to the leader.
   * The answer arrives later as a checkin-ack or checkin-failed event.
   */
  async sendCheckIn(target: number): Promise<number> {
    if (target === MESH_BROADCAST_ID) {
      if (!this.myNode) throw new Error("The leader board is not ready for a check-in yet.");
      const written = this.whenWritten();
      const sending = this.device.sendText("CHECK IN", MESH_BROADCAST_ID, false, 0);
      await Promise.race([written, sending.then(() => written)]);
      return 0;
    }
    if (!this.myNode || !this.nodes.has(target) || target === this.myNode) {
      throw new Error("The leader has not identified that follower yet.");
    }
    for (const [packetId, pendingTarget] of this.pending) {
      if (pendingTarget === target) this.pending.delete(packetId);
    }
    this.echoedTextId = null;
    const sending = this.device.sendText("CHECK IN", target >>> 0, true);
    const packetId = this.echoedTextId as number | null;
    this.echoedTextId = null;
    if (packetId == null) {
      void sending.catch(() => undefined);
      throw new Error("The leader board is not ready for a check-in yet.");
    }
    const written = this.whenWritten();
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
    } else if (from >= FIRST_NODE && this.myNode !== 0 && !packet.viaMqtt && !this.ignored.has(from)) {
      this.onHeard(from);
      if (decoded) this.onFollowerPacket(packet, decoded);
    }

    if (from === this.myNode && from >= FIRST_NODE && decoded?.portnum === Protobuf.Portnums.PortNum.POSITION_APP) {
      this.onPosition(from, fromBinary(Protobuf.Mesh.PositionSchema, decoded.payload), packetTime(packet));
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

  /** Decode positions and names here so the packet's MQTT flag applies to discovery and updates alike. */
  private onFollowerPacket(packet: Protobuf.Mesh.MeshPacket, data: Protobuf.Mesh.Data): void {
    const from = packet.from >>> 0;
    switch (data.portnum) {
      case Protobuf.Portnums.PortNum.POSITION_APP:
        this.onPosition(from, fromBinary(Protobuf.Mesh.PositionSchema, data.payload), packetTime(packet));
        return;
      case Protobuf.Portnums.PortNum.NODEINFO_APP:
        this.onUser(from, fromBinary(Protobuf.Mesh.UserSchema, data.payload), Date.now());
        return;
      case Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP: {
        if (packet.to !== this.myNode) return;
        // Meshtastic's Detection Sensor module can prepend a bell to text.
        const text = new TextDecoder().decode(data.payload).replace(/[\u0000-\u001f\u007f]/g, "").trim();
        if (text) this.emit(live({ text, fromId: from }));
        return;
      }
    }
  }

  /** Discovery works even before a follower shares its name or gets a GPS fix. */
  private onHeard(id: number, name?: string, at: number | null = Date.now()): void {
    const previous = this.nodes.get(id);
    if (previous && !name) {
      if (at != null) this.emit({ type: "heard", id, at });
      return;
    }
    const node = {
      fix: false,
      lat: null,
      lon: null,
      ...previous,
      name: name ?? defaultNodeName(id),
    };
    this.nodes.set(id, node);
    this.emit({ type: "node-seen", id, name: node.name, at });
  }

  private onNode(info: Protobuf.Mesh.NodeInfo): void {
    if (this.myNode === 0) {
      this.nodesBeforeIdentity.push(info);
      return;
    }
    const id = info.num >>> 0;
    if (id < FIRST_NODE) return;
    const heardAt = info.lastHeard > REAL_TIME_SEC ? Math.min(info.lastHeard * 1000, Date.now()) : null;
    if (id !== this.myNode) {
      if (info.isIgnored) {
        this.ignored.add(id);
        if (this.nodes.delete(id)) this.emit(live({ followerGoneId: id }));
        return;
      }
      this.ignored.delete(id);
      if (info.viaMqtt) return;

      // A position record can contain only clock information. Always register the node first.
      const name = advertisedName(info.user);
      this.onHeard(id, name, heardAt);
    }
    if (info.position) this.onPosition(id, info.position, heardAt);
  }

  private onPosition(
    id: number,
    position: Protobuf.Mesh.Position,
    heardAt: number | null,
  ): void {
    if (id < FIRST_NODE || this.ignored.has(id)) return;
    // A clock-only or no-fix packet carries no location. Keep the last reported coordinates.
    const fix = readPosition(position);
    if (!fix) return;
    const positionAt = positionTime(position, heardAt);
    const previousAt = this.lastPositionAt.get(id);
    if (previousAt != null && positionAt != null && positionAt < previousAt) return;
    if (positionAt != null) this.lastPositionAt.set(id, positionAt);
    if (id === this.myNode) {
      this.emit(live({ gps: { ...fix, at: positionAt } }));
      return;
    }
    const previous = this.nodes.get(id);
    const node: HeardNode = {
      name: previous?.name ?? defaultNodeName(id),
      ...fix,
    };
    this.nodes.set(id, node);
    this.emit(followerEvent(id, node, heardAt, positionAt));
  }

  private onUser(id: number, user: Protobuf.Mesh.User | undefined, heardAt: number | null): void {
    if (id < FIRST_NODE || id === this.myNode || this.ignored.has(id) || !user) return;
    const previous = this.nodes.get(id);
    const node: HeardNode = {
      name: advertisedName(user) ?? previous?.name ?? defaultNodeName(id),
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
  return { type: "live", ...partial };
}

function advertisedName(user: Protobuf.Mesh.User | undefined): string | undefined {
  return user?.longName?.trim() || user?.shortName?.trim() || undefined;
}

function defaultNodeName(id: number): string {
  return `Meshtastic ${(id >>> 0).toString(16).slice(-4).toUpperCase()}`;
}

/** Use the fix timestamp first. A packet can also carry a separate clock-sync time. */
function positionTime(position: Protobuf.Mesh.Position, heardAt: number | null): number | null {
  const time = position.timestamp > REAL_TIME_SEC ? position.timestamp : position.time;
  return time > REAL_TIME_SEC ? Math.min(time * 1000, Date.now()) : heardAt;
}

function packetTime(packet: Protobuf.Mesh.MeshPacket): number | null {
  return packet.rxTime != null && packet.rxTime > REAL_TIME_SEC
    ? Math.min(packet.rxTime * 1000, Date.now())
    : null;
}

function readPosition(position: Protobuf.Mesh.Position): { fix: true; lat: number; lon: number } | null {
  const latI = position.latitudeI;
  const lonI = position.longitudeI;
  if (latI == null || lonI == null || (latI === 0 && lonI === 0)) return null;
  const lat = latI / 1e7;
  const lon = lonI / 1e7;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { fix: true, lat, lon };
}

/** The Wearable button sends a plain OK text. */
export function isOkText(text: string): boolean {
  return /^OK$/i.test(text.trim());
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
