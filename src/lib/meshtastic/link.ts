import { fromBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf } from "@meshtastic/core";
import type { BleEvent } from "../ble/transport";

const FIRST_NODE = 4;
const REAL_TIME_SEC = 1_600_000_000;
const QUIET_MS = 6 * 60 * 60 * 1000;
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
  private readonly rejected = new Set<number>();
  private writeWaiters: WriteWaiter[] = [];
  /** Check-in packet id → the board it was sent to. */
  private readonly pending = new Map<number, number>();
  /** Set by the radio's echo of a text this phone just sent. */
  private echoedTextId: number | null = null;

  constructor(write: (bytes: Uint8Array) => Promise<void>, onEvent: (event: BleEvent) => void) {
    this.onEvent = onEvent;
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
      if (this.nodes.delete(this.myNode)) this.emit(live({ followerGoneId: this.myNode }));
    });
    this.device.events.onNodeInfoPacket.subscribe((info: Protobuf.Mesh.NodeInfo) => {
      this.onNode(info);
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
      const ok = text.toUpperCase() === "OK" || text.toUpperCase().startsWith("OK ");
      this.emit(live({ text, okId: ok ? from : null }));
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
    } else if (from >= FIRST_NODE && this.nodes.has(from)) {
      this.emit({ type: "heard", id: from, at: Date.now() });
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

  private onNode(info: Protobuf.Mesh.NodeInfo): void {
    const id = info.num >>> 0;
    const heardAt = info.lastHeard > REAL_TIME_SEC ? Math.min(info.lastHeard * 1000, Date.now()) : null;
    const stale = heardAt != null && Date.now() - heardAt > QUIET_MS;
    if (info.viaMqtt || info.isIgnored || (info.hopsAway ?? 0) > 2 || stale) {
      this.rejected.add(id);
      if (this.nodes.delete(id)) this.emit(live({ followerGoneId: id }));
      return;
    }
    this.rejected.delete(id);
    const name = nodeName(info.user, id);
    if (info.position) this.onPosition(id, info.position, heardAt, name);
    else this.onUser(id, info.user, heardAt);
  }

  private onPosition(
    id: number,
    position: Protobuf.Mesh.Position,
    heardAt: number | null,
    name: string | undefined,
  ): void {
    if (id < FIRST_NODE || this.rejected.has(id)) return;
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
    if (id < FIRST_NODE || id === this.myNode || this.rejected.has(id) || !user) return;
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
