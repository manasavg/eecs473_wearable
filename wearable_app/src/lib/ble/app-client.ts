import { MESH_BROADCAST_ID } from "./constants";
import { isOkText } from "../meshtastic/link";
import { createTransport, type LinkMode } from "./create-transport";
import type { BleEvent, BlePeer, BleTransport } from "./transport";

export type ConnectionState =
  | "disconnected"
  | "scanning"
  | "connected"
  | "reconnecting"
  | "error";

export const CHECK_IN_TIMEOUT_MS = 120_000;

export interface FollowerCheckIn {
  status: "sending" | "waiting" | "received" | "ok" | "help" | "noAnswer" | "failed";
  sentAt: number;
  packetId: number | null;
  reason?: string;
}

export function isPendingCheckIn(checkIn: FollowerCheckIn | undefined, now: number): boolean {
  return Boolean(checkIn && (
    checkIn.status === "sending" ||
    ((checkIn.status === "waiting" || checkIn.status === "received") && now - checkIn.sentAt < CHECK_IN_TIMEOUT_MS)
  ));
}

export interface TrackedFollower {
  name?: string | undefined;
  id: number;
  fix: boolean | null;
  lat: number | null;
  lon: number | null;
}

export interface AppState {
  checkIns: Record<number, FollowerCheckIn>;
  mode: "idle" | LinkMode;
  connection: ConnectionState;
  error: string | null;
  deviceName: string | null;
  /** When the check-in write reached the leader. The app is waiting for a follower OK. */
  groupCheckInAt: number | null;
  gpsFix: boolean | null;
  gpsLat: number | null;
  gpsLon: number | null;
  /** The other boards. Empty until the leader hears one. */
  followers: TrackedFollower[];
}

export function createInitialState(): AppState {
  return {
    checkIns: {},
    mode: "idle",
    connection: "disconnected",
    error: null,
    deviceName: null,
    groupCheckInAt: null,
    gpsFix: null,
    gpsLat: null,
    gpsLon: null,
    followers: [],
  };
}

function upsertTracked(
  followers: TrackedFollower[],
  id: number,
  patch: Partial<Omit<TrackedFollower, "id">>,
): TrackedFollower[] {
  const previous = followers.find((follower) => follower.id === id);
  const next: TrackedFollower = {
    id,
    ...(patch.name ?? previous?.name ? { name: patch.name ?? previous?.name } : {}),
    fix: patch.fix !== undefined ? patch.fix : (previous?.fix ?? null),
    lat: patch.lat !== undefined ? patch.lat : (previous?.lat ?? null),
    lon: patch.lon !== undefined ? patch.lon : (previous?.lon ?? null),
  };
  return [...followers.filter((follower) => follower.id !== id), next].sort((a, b) => a.id - b.id);
}

export class ExcursionAppClient {
  private state = createInitialState();
  private transport: BleTransport | null = null;
  private scanLink: BleTransport | null = null;
  private scanStop: (() => void) | null = null;
  private scanGeneration = 0;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(state: AppState) => void>();
  private closing = false;

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): AppState {
    return this.state;
  }

  /**
   * Look for Excursion boards. The callback fires as each one advertises.
   * Resolves after about 10 seconds, or sooner when connectDevice runs.
   */
  async scanForDevices(onPeer: (peer: BlePeer) => void): Promise<void> {
    await this.stopDeviceScan();
    const generation = ++this.scanGeneration;
    const link = createTransport("beacon");
    this.scanLink = link;
    if (!link.scan) {
      this.scanLink = null;
      return;
    }
    try {
      await link.scan(onPeer);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10000);
        this.scanStop = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } finally {
      if (this.scanGeneration === generation) {
        this.scanStop = null;
        this.scanLink = null;
        await link.stopScan?.();
      }
    }
  }

  async stopDeviceScan(): Promise<void> {
    this.scanGeneration += 1;
    const stop = this.scanStop;
    this.scanStop = null;
    stop?.();
    const link = this.scanLink;
    this.scanLink = null;
    await link?.stopScan?.();
  }

  /**
   * Pass a transport only from tests. The click handler must call this
   * directly so Web Bluetooth's chooser still counts as a user gesture.
   */
  async connectDevice(
    mode: LinkMode,
    transport?: BleTransport,
    remembered = false,
    peer?: BlePeer,
  ): Promise<void> {
    await this.stopDeviceScan();
    const previous = this.transport;
    this.release();
    // Do not await here. requestDevice() has to stay inside the click gesture.
    void previous?.disconnect();
    const link = transport ?? createTransport(mode);
    this.transport = link;
    this.unsubscribe = link.subscribe((event) => {
      void this.parseData(event);
    });
    this.commit({
      ...createInitialState(),
      mode,
      connection: "scanning",
    });

    try {
      await link.connect(remembered, peer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not connect.";
      const failed = this.transport;
      this.release();
      void failed?.disconnect();
      this.commit({
        ...createInitialState(),
        connection: "error",
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    await this.stopDeviceScan();
    if (!this.transport && this.state.mode === "idle") return;
    this.closing = true;
    try {
      await this.transport?.disconnect();
    } finally {
      this.release();
      this.closing = false;
      this.commit(createInitialState());
    }
  }

  /** Send one check-in through the connected leader. */
  async sendCheckIn(targetId: number, groupIds: number[] = [targetId]): Promise<void> {
    if (!this.transport || this.state.connection !== "connected") {
      throw new Error("Connect the beacon before sending a check-in.");
    }
    const previous = this.state.checkIns[targetId];
    const now = Date.now();
    if (previous && isPendingCheckIn(previous, now)) return;
    const attempt: FollowerCheckIn = { status: "sending", sentAt: now, packetId: null };
    this.commit({ ...this.state, error: null });
    for (const id of groupIds) this.updateCheckIn(id, attempt);
    try {
      await this.transport.sendCheckIn(targetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check-in did not reach the beacon.";
      for (const id of groupIds) {
        if (this.state.checkIns[id] === attempt || this.state.checkIns[id]?.status === "waiting") {
          this.updateCheckIn(id, { ...attempt, status: "failed", reason: message });
        }
      }
      this.commit({ ...this.state, error: message });
      throw error instanceof Error ? error : new Error(message);
    }
    if (targetId === MESH_BROADCAST_ID) {
      for (const id of groupIds) {
        if (this.state.checkIns[id] === attempt) {
          this.updateCheckIn(id, { ...attempt, status: "waiting" });
        }
      }
    }
    this.commit({ ...this.state, groupCheckInAt: now });
  }

  private updateCheckIn(id: number, checkIn: FollowerCheckIn): void {
    this.commit({ ...this.state, checkIns: { ...this.state.checkIns, [id]: checkIn } });
  }

  async parseData(event: BleEvent): Promise<void> {
    switch (event.type) {
      case "connected":
        this.commit({ ...this.state, connection: "connected", error: null, deviceName: event.deviceName });
        return;
      case "disconnected":
        if (this.closing || !event.unexpected) return;
        this.commit({
          ...this.state,
          connection: "disconnected",
          error: "The beacon link dropped.",
        });
        return;
      case "reconnecting":
        this.commit({ ...this.state, connection: "reconnecting", error: null });
        return;
      case "error":
        this.commit({ ...this.state, error: event.message });
        return;
      case "node-seen":
        this.commit({
          ...this.state,
          followers: upsertTracked(this.state.followers, event.id, { name: event.name }),
        });
        return;
      case "checkin-sent": {
        const checkIn = this.state.checkIns[event.id];
        if (checkIn?.status === "sending") {
          this.updateCheckIn(event.id, { ...checkIn, status: "waiting", packetId: event.packetId });
        }
        return;
      }
      case "checkin-ack":
      case "checkin-failed": {
        const checkIn = this.state.checkIns[event.id];
        if (checkIn?.packetId !== event.packetId || checkIn.status !== "waiting") return;
        this.updateCheckIn(event.id, event.type === "checkin-ack"
          ? { ...checkIn, status: "received" }
          : { ...checkIn, status: event.noAnswer ? "noAnswer" : "failed", reason: event.reason });
        return;
      }
      case "live": {
        const now = Date.now();
        const sender = event.fromId;
        const followerOk = event.text != null && isOkText(event.text);
        const text = event.text?.trim().toUpperCase();
        const followerHelp = text === "HELP" || text === "NEED HELP" || text === "NEEDS HELP" ||
          text?.startsWith("NEEDS HELP ");
        const checkIn = sender == null ? undefined : this.state.checkIns[sender];
        if (sender != null && (followerOk || (followerHelp && (checkIn || this.state.groupCheckInAt != null)))) {
          this.updateCheckIn(sender, {
            sentAt: checkIn?.sentAt ?? this.state.groupCheckInAt ?? now,
            packetId: checkIn?.packetId ?? null,
            status: followerHelp ? "help" : "ok",
          });
        }
        const gps = event.gps;
        let followers = this.state.followers;
        if (sender != null && this.state.checkIns[sender] && (followerOk || followerHelp)) {
          followers = upsertTracked(followers, sender, {});
        }
        if (event.followerGoneId != null) {
          followers = followers.filter((follower) => follower.id !== event.followerGoneId);
        }
        if (event.followerGps) {
          followers = upsertTracked(
            followers,
            event.followerGps.id,
            {
              name: event.followerGps.name ?? undefined,
              fix: event.followerGps.fix,
              lat: event.followerGps.lat,
              lon: event.followerGps.lon,
            },
          );
        }
        this.commit({
          ...this.state,
          followers,
          gpsFix: gps ? gps.fix : this.state.gpsFix,
          gpsLat: gps ? gps.lat : this.state.gpsLat,
          gpsLon: gps ? gps.lon : this.state.gpsLon,
        });
        return;
      }
      default:
        return;
    }
  }

  dismissError(): void {
    if (!this.state.error) return;
    this.commit({ ...this.state, error: null });
  }

  private release(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.transport = null;
  }

  private commit(next: AppState): void {
    this.state = next;
    for (const listener of this.listeners) listener(this.state);
  }
}
