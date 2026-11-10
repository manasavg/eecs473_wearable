import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";
import { haversineMeters } from "../geo";
import type { BleEvent } from "../ble/transport";

const BROADCAST = 0xffffffff;
/** A node that has not been heard for this long drops off the follower list. */
const QUIET_MS = 10 * 60 * 1000;

interface Fix {
  fix: boolean;
  lat: number | null;
  lon: number | null;
  heardMs: number;
}

/**
 * Turns Meshtastic FromRadio protobufs into the follower positions the
 * dashboard already stores. The connected node is the leader. Every other
 * node in its database is a follower.
 */
export class MeshSession {
  private myNode = 0;
  private self: Fix = { fix: false, lat: null, lon: null, heardMs: 0 };
  private followers = new Map<number, Fix>();

  wantConfig(id = 1): Uint8Array {
    return toBinary(
      Mesh.ToRadioSchema,
      create(Mesh.ToRadioSchema, {
        payloadVariant: { case: "wantConfigId", value: id },
      }),
    );
  }

  /** A channel text. The dashboard sends CHECK IN this way. */
  textPacket(text: string): Uint8Array {
    const packet = create(Mesh.MeshPacketSchema, {
      to: BROADCAST,
      channel: 0,
      id: packetId(),
      hopLimit: 3,
      wantAck: false,
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
    } else if (variant.case === "nodeInfo") {
      const heard = variant.value.lastHeard > 0 ? variant.value.lastHeard * 1000 : now;
      events.push(...this.place(variant.value.num >>> 0, variant.value.position, heard, now));
    } else if (variant.case === "packet") {
      events.push(...this.onPacket(variant.value, now));
    }
    events.push(...this.expire(now));
    return events;
  }

  private onPacket(packet: Mesh.MeshPacket, now: number): BleEvent[] {
    if (packet.payloadVariant.case !== "decoded") return [];
    const data = packet.payloadVariant.value;
    const from = packet.from >>> 0;
    if (data.portnum === Portnums.PortNum.POSITION_APP) {
      let position: Mesh.Position;
      try {
        position = fromBinary(Mesh.PositionSchema, data.payload);
      } catch {
        return [];
      }
      return this.place(from, position, now, now);
    }
    if (data.portnum !== Portnums.PortNum.TEXT_MESSAGE_APP || from === this.myNode) return [];
    const text = new TextDecoder().decode(data.payload).replace(/\0+$/, "").trim();
    if (!text) return [];
    const ok = text.toUpperCase() === "OK" || text.toUpperCase().startsWith("OK ");
    return [
      {
        type: "live",
        counter: null,
        text,
        hex: "",
        okId: ok ? from : null,
      },
    ];
  }

  private place(id: number, position: Mesh.Position | undefined, heardMs: number, now: number): BleEvent[] {
    if (id === 0) return [];
    const fix = readFix(position);
    if (id === this.myNode) {
      this.self = { ...fix, heardMs };
      return [
        {
          type: "live",
          counter: null,
          text: null,
          hex: "",
          gps: { fix: fix.fix, lat: fix.lat, lon: fix.lon },
        },
        ...this.separations(now),
      ];
    }
    this.followers.set(id, { ...fix, heardMs });
    return [this.followerEvent(id, this.followers.get(id)!)];
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
    return {
      type: "live",
      counter: null,
      text: null,
      hex: "",
      followerGps: { id, fix: follower.fix, lat: follower.lat, lon: follower.lon },
      separation: { id, known, meters },
    };
  }

  private expire(now: number): BleEvent[] {
    const events: BleEvent[] = [];
    for (const [id, follower] of this.followers) {
      if (now - follower.heardMs <= QUIET_MS) continue;
      this.followers.delete(id);
      events.push({
        type: "live",
        counter: null,
        text: null,
        hex: "",
        followerGoneId: id,
      });
    }
    return events;
  }
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
