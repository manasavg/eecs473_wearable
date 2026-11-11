import { MeshDevice, Protobuf } from "@meshtastic/core";
import type { BleEvent } from "../ble/transport";

const FIRST_NODE = 4;
const REAL_TIME_SEC = 1_600_000_000;
const QUIET_MS = 6 * 60 * 60 * 1000;

interface HeardNode {
  name: string;
  fix: boolean;
  lat: number | null;
  lon: number | null;
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
  private readonly writeWaiters: Array<() => void> = [];

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
        await write(bytes);
        const waiting = this.writeWaiters.splice(0);
        for (const resolve of waiting) resolve();
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
    this.device.events.onPositionPacket.subscribe((packet: { from: number; data: Protobuf.Mesh.Position }) => {
      this.onPosition(packet.from >>> 0, packet.data);
    });
    this.device.events.onUserPacket.subscribe((packet: { from: number; data: Protobuf.Mesh.User }) => {
      this.onUser(packet.from >>> 0, packet.data);
    });
    this.device.events.onMessagePacket.subscribe((packet: { from: number; data: string }) => {
      const from = packet.from >>> 0;
      if (from === this.myNode || from < FIRST_NODE) return;
      const text = packet.data.replace(/\0+$/, "").trim();
      if (!text) return;
      const ok = text.toUpperCase() === "OK" || text.toUpperCase().startsWith("OK ");
      this.emit(live({ text, okId: ok ? from : null }));
    });
    this.device.events.onRoutingPacket.subscribe((packet: { from: number; data: Protobuf.Mesh.Routing }) => {
      if (packet.data.variant.case !== "errorReason") return;
      if (packet.data.variant.value !== Protobuf.Mesh.Routing_Error.NONE) return;
      const from = packet.from >>> 0;
      if (from < FIRST_NODE || from === this.myNode) return;
      this.emit(live({ text: "OK", okId: from }));
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

  /** Meshtastic text to each other board. Resolves once each text is written. */
  async sendCheckIn(): Promise<void> {
    const targets = [...this.nodes.keys()];
    const destinations = targets.length > 0 ? targets : (["broadcast"] as const);
    for (const destination of destinations) {
      const written = this.whenWritten();
      void this.device.sendText("CHECK IN", destination, true).catch(() => undefined);
      await written;
    }
  }

  private whenWritten(): Promise<void> {
    return new Promise((resolve) => {
      this.writeWaiters.push(resolve);
    });
  }

  private onNode(info: Protobuf.Mesh.NodeInfo): void {
    const id = info.num >>> 0;
    const stale =
      info.lastHeard > REAL_TIME_SEC && Date.now() - info.lastHeard * 1000 > QUIET_MS;
    if (info.viaMqtt || info.isIgnored || (info.hopsAway ?? 0) > 2 || stale) {
      this.rejected.add(id);
      if (this.nodes.delete(id)) this.emit(live({ followerGoneId: id }));
      return;
    }
    this.rejected.delete(id);
    const name = nodeName(info.user, id);
    if (info.position) this.onPosition(id, info.position, name);
    else this.onUser(id, info.user);
  }

  private onPosition(id: number, position: Protobuf.Mesh.Position, name?: string): void {
    if (id < FIRST_NODE || this.rejected.has(id)) return;
    const fix = readFix(position);
    if (id === this.myNode) {
      this.emit(live({ gps: fix }));
      return;
    }
    const previous = this.nodes.get(id);
    const node: HeardNode = {
      name: name || previous?.name || nodeName(undefined, id),
      ...fix,
    };
    this.nodes.set(id, node);
    this.emit(followerEvent(id, node));
  }

  private onUser(id: number, user: Protobuf.Mesh.User | undefined): void {
    if (id < FIRST_NODE || id === this.myNode || this.rejected.has(id) || !user) return;
    const previous = this.nodes.get(id);
    const node: HeardNode = {
      name: nodeName(user, id),
      fix: previous?.fix ?? false,
      lat: previous?.lat ?? null,
      lon: previous?.lon ?? null,
    };
    this.nodes.set(id, node);
    this.emit(followerEvent(id, node));
  }

  private emit(event: BleEvent): void {
    this.onEvent(event);
  }
}

function followerEvent(id: number, node: HeardNode): BleEvent {
  return live({
    followerGps: { id, fix: node.fix, lat: node.lat, lon: node.lon, name: node.name },
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
