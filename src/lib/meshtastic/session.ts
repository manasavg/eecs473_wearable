import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";
import { haversineMeters } from "../geo";
import type { BleEvent } from "../ble/transport";

const BROADCAST = 0xffffffff;
/** Node numbers 0–3 are reserved by Meshtastic. */
const FIRST_NODE = 4;
/** A real clock reading. Anything earlier is an unset radio clock. */
const REAL_TIME_SEC = 1_600_000_000;
/** Drop a node the radio has not heard for this long, when its clock is valid. */
const QUIET_MS = 6 * 60 * 60 * 1000;

interface Fix {
  fix: boolean;
  lat: number | null;
  lon: number | null;
  heardMs: number;
  name: string;
}

/**
 * Turns Meshtastic FromRadio protobufs into the follower positions the
 * dashboard already stores. The connected node is the leader. Every other
 * node in its database is a follower.
 */
export class MeshSession {
  private myNode = 0;
  private self: Fix = { fix: false, lat: null, lon: null, heardMs: 0, name: "" };
  private followers = new Map<number, Fix>();
  /** Packet id to the follower it was sent to. A routing ack for that id means OK. */
  private pendingAcks = new Map<number, number>();

  wantConfig(id = 1): Uint8Array {
    return toBinary(
      Mesh.ToRadioSchema,
      create(Mesh.ToRadioSchema, {
        payloadVariant: { case: "wantConfigId", value: id },
      }),
    );
  }

  /**
   * One CHECK IN for each other board, asking that board to acknowledge it.
   * A broadcast is used only when this radio has not heard the others yet.
   */
  checkInPackets(): Uint8Array[] {
    const targets = [...this.followers.keys()];
    const destinations = targets.length > 0 ? targets : [BROADCAST];
    return destinations.map((to) => this.textPacket("CHECK IN", to, to !== BROADCAST));
  }

  /** A channel or direct text. Direct messages request an acknowledgement. */
  textPacket(text: string, to = BROADCAST, wantAck = false): Uint8Array {
    const id = packetId();
    if (wantAck && to !== BROADCAST) this.pendingAcks.set(id, to >>> 0);
    const packet = create(Mesh.MeshPacketSchema, {
      from: this.myNode,
      to,
      channel: 0,
      id,
      hopLimit: 3,
      hopStart: 3,
      wantAck,
      priority: wantAck ? Mesh.MeshPacket_Priority.RELIABLE : Mesh.MeshPacket_Priority.DEFAULT,
      payloadVariant: {
        case: "decoded",
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
          payload: new TextEncoder().encode(text),
        }),
      },
    });
    return toBinary(
      Mesh.ToRadioSchema,
      create(Mesh.ToRadioSchema, {
        payloadVariant: { case: "packet", value: packet },
      }),
    );
  }

  ingest(bytes: Uint8Array, now = Date.now()): BleEvent[] {
    if (bytes.length === 0) return [];
    let message: Mesh.FromRadio;
    try {
      message = fromBinary(Mesh.FromRadioSchema, bytes);
    } catch {
      return [];
    }
    const events: BleEvent[] = [];
    const variant = message.payloadVariant;
    if (variant.case === "myInfo") {
      this.myNode = variant.value.myNodeNum >>> 0;
      events.push(...this.drop(this.myNode));
    } else if (variant.case === "nodeInfo") {
      events.push(...this.onNode(variant.value, now));
    } else if (variant.case === "packet") {
      events.push(...this.onPacket(variant.value, now));
    }
    events.push(...this.expire(now));
    return events;
  }

  private onNode(info: Mesh.NodeInfo, now: number): BleEvent[] {
    const id = info.num >>> 0;
    if (info.viaMqtt || info.isIgnored || (info.hopsAway ?? 0) > 2) return this.drop(id);
    if (info.lastHeard > REAL_TIME_SEC && now - info.lastHeard * 1000 > QUIET_MS) return this.drop(id);
    const heard = info.lastHeard > REAL_TIME_SEC ? info.lastHeard * 1000 : now;
    return this.place(id, info.position, heard, now, nodeName(info.user, id));
  }

  private onPacket(packet: Mesh.MeshPacket, now: number): BleEvent[] {
    if (packet.viaMqtt || packet.payloadVariant.case !== "decoded") return [];
    const data = packet.payloadVariant.value;
    const from = packet.from >>> 0;
    if (data.portnum === Portnums.PortNum.ROUTING_APP) return this.onAck(data, from);
    if (data.portnum === Portnums.PortNum.POSITION_APP) {
      let position: Mesh.Position;
      try {
        position = fromBinary(Mesh.PositionSchema, data.payload);
      } catch {
        return [];
      }
      return this.place(from, position, now, now, this.followers.get(from)?.name);
    }
    if (data.portnum !== Portnums.PortNum.TEXT_MESSAGE_APP || from === this.myNode) return [];
    const text = new TextDecoder().decode(data.payload).replace(/\0+$/, "").trim();
    if (!text) return [];
    const ok = text.toUpperCase() === "OK" || text.toUpperCase().startsWith("OK ");
    return [live({ text, okId: ok ? from : null })];
  }

  private onAck(data: Mesh.Data, from: number): BleEvent[] {
    const requestId = data.requestId >>> 0;
    const dest = this.pendingAcks.get(requestId);
    if (dest == null) return [];
    let routing: Mesh.Routing;
    try {
      routing = fromBinary(Mesh.RoutingSchema, data.payload);
    } catch {
      return [];
    }
    if (routing.variant.case === "errorReason" && routing.variant.value !== Mesh.Routing_Error.NONE) {
      this.pendingAcks.delete(requestId);
      return [];
    }
    this.pendingAcks.delete(requestId);
    const id = from >= FIRST_NODE && from !== this.myNode ? from : dest;
    return [live({ text: "OK", okId: id })];
  }

  private place(
    id: number,
    position: Mesh.Position | undefined,
    heardMs: number,
    now: number,
    name?: string,
  ): BleEvent[] {
    if (id < FIRST_NODE) return [];
    const fix = readFix(position);
    if (id === this.myNode) {
      this.self = { ...fix, heardMs, name: name ?? this.self.name };
      return [
        live({ gps: { fix: fix.fix, lat: fix.lat, lon: fix.lon } }),
        ...this.separations(now),
      ];
    }
    const previous = this.followers.get(id);
    this.followers.set(id, { ...fix, heardMs, name: name || previous?.name || nodeName(undefined, id) });
    return [this.followerEvent(id, this.followers.get(id)!)];
  }

  private drop(id: number): BleEvent[] {
    if (!this.followers.delete(id)) return [];
    return [live({ followerGoneId: id })];
  }

  private separations(now: number): BleEvent[] {
    const events: BleEvent[] = [];
    for (const [id, follower] of this.followers) {
      if (now - follower.heardMs > QUIET_MS) continue;
      events.push(this.followerEvent(id, follower));
    }
    return events;
  }

  private followerEvent(id: number, follower: Fix): BleEvent {
    const known = this.self.fix && follower.fix && this.self.lat != null && this.self.lon != null && follower.lat != null && follower.lon != null;
    const meters = known ? haversineMeters(this.self.lat!, this.self.lon!, follower.lat!, follower.lon!) : null;
    return live({
      followerGps: { id, fix: follower.fix, lat: follower.lat, lon: follower.lon, name: follower.name },
      separation: { id, known, meters },
    });
  }

  private expire(now: number): BleEvent[] {
    const events: BleEvent[] = [];
    for (const [id, follower] of this.followers) {
      if (now - follower.heardMs <= QUIET_MS) continue;
      this.followers.delete(id);
      events.push(live({ followerGoneId: id }));
    }
    return events;
  }
}

function live(partial: Partial<Extract<BleEvent, { type: "live" }>>): BleEvent {
  return { type: "live", counter: null, text: null, hex: "", ...partial };
}

function nodeName(user: Mesh.User | undefined, id: number): string {
  const longName = user?.longName?.trim();
  const shortName = user?.shortName?.trim();
  if (longName) return longName;
  if (shortName) return shortName;
  return `Meshtastic ${(id >>> 0).toString(16).slice(-4).toUpperCase()}`;
}

function readFix(position: Mesh.Position | undefined): { fix: boolean; lat: number | null; lon: number | null } {
  const latI = position?.latitudeI;
  const lonI = position?.longitudeI;
  if (latI == null || lonI == null || (latI === 0 && lonI === 0)) {
    return { fix: false, lat: null, lon: null };
  }
  const lat = latI / 1e7;
  const lon = lonI / 1e7;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { fix: false, lat: null, lon: null };
  return { fix: true, lat, lon };
}

function packetId(): number {
  const bytes = new Uint32Array(1);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    const id = bytes[0] & 0x7fffffff;
    return id === 0 ? 1 : id;
  }
  return Math.floor(Math.random() * 0x7ffffffe) + 1;
}
