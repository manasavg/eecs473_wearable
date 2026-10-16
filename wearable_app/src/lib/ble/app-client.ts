import { BROADCAST_ID, DEFAULT_THRESHOLD_M } from "./constants";
import { createTransport, type LinkMode } from "./create-transport";
import { isFollowerOkSignal } from "./live-link";
import { clampThreshold } from "./protocol";
import type { BleEvent, BleTransport } from "./transport";
import { CmdType, Status, type FollowerInfo, type LabSample } from "./types";

/**
 * Phone side of Appendix C `class App`.
 *
 *   connect_device()   → connectDevice()
 *   parse_data()       → parseData()
 *   send_check_in(id)  → sendCheckIn()     // 0xFF = the whole group
 *   update_ui()        → subscribe()
 *   trigger_alert(id)  → triggerAlert()
 *
 * The UI renders `AppState`. It does not parse bytes and it does not
 * decide that someone is lost — the beacon does, and parseData records it.
 */

export type ConnectionState =
  | "disconnected"
  | "scanning"
  | "connected"
  | "reconnecting"
  | "error";

export interface MemberState {
  deviceId: number;
  status: Status;
  batteryPercent: number | null;
  distanceM: number | null;
  angleDeg: number | null;
  uwbOutOfRange: boolean;
  lastDistanceM: number | null;
  lastAngleDeg: number | null;
  /** When the status byte became CHECKIN_PENDING. */
  pendingSince: number | null;
  /** When this phone sent a check-in. Drives the 60 s countdown immediately. */
  checkInSentAt: number | null;
  updatedAt: number;
  lab: LabSample | null;
}

export interface ActiveAlert {
  deviceId: number;
  status: Status.NEED_HELP | Status.OUT_OF_RANGE;
  at: number;
}

export type ActivityKind =
  | "linked"
  | "checkin"
  | "answered"
  | "help"
  | "separated"
  | "returned"
  | "threshold"
  | "cleared"
  | "error";

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  deviceId?: number;
  meters?: number;
  message?: string;
}

/** What the flashed ESP32 sketch is sending right now. */
export interface LiveLink {
  counter: number | null;
  text: string | null;
  packetCount: number;
  lastHex: string;
}

export interface AppState {
  mode: "idle" | LinkMode;
  connection: ConnectionState;
  error: string | null;
  deviceName: string | null;
  leaderBatteryPercent: number | null;
  thresholdMeters: number;
  members: MemberState[];
  alerts: ActiveAlert[];
  activity: ActivityEntry[];
  lastPacketAt: number | null;
  liveLink: LiveLink | null;
  /** When the check-in write reached the leader. The app is waiting for a follower OK. */
  groupCheckInAt: number | null;
  /** When the leader notified that a follower pressed OK. No wearable id. */
  groupOkAt: number | null;
  /** Latest filtered UWB range between the leader anchor and the follower tag. */
  uwbDistanceM: number | null;
}

export function createInitialState(thresholdMeters = DEFAULT_THRESHOLD_M): AppState {
  return {
    mode: "idle",
    connection: "disconnected",
    error: null,
    deviceName: null,
    leaderBatteryPercent: null,
    thresholdMeters: clampThreshold(thresholdMeters),
    members: [],
    alerts: [],
    activity: [],
    lastPacketAt: null,
    liveLink: null,
    groupCheckInAt: null,
    groupOkAt: null,
    uwbDistanceM: null,
  };
}

export class ExcursionAppClient {
  private state: AppState;
  private transport: BleTransport | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(state: AppState) => void>();
  private closing = false;

  constructor(initial?: { thresholdMeters?: number }) {
    this.state = createInitialState(initial?.thresholdMeters);
  }

  /** Appendix C: update_ui — the dashboard subscribes instead of polling. */
  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): AppState {
    return this.state;
  }

  /**
   * Appendix C: connect_device.
   * Pass a transport only from tests. The click handler must call this
   * directly so Web Bluetooth's chooser still counts as a user gesture.
   */
  async connectDevice(mode: LinkMode, transport?: BleTransport, remembered = false): Promise<void> {
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
      ...createInitialState(this.state.thresholdMeters),
      mode,
      connection: "scanning",
      thresholdMeters: this.state.thresholdMeters,
    });

    try {
      await link.connect(remembered);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not connect.";
      const failed = this.transport;
      this.release();
      void failed?.disconnect();
      this.commit({
        ...createInitialState(this.state.thresholdMeters),
        connection: "error",
        error: message,
        thresholdMeters: this.state.thresholdMeters,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.transport && this.state.mode === "idle") return;
    this.closing = true;
    const threshold = this.state.thresholdMeters;
    try {
      await this.transport?.disconnect();
    } finally {
      this.release();
      this.closing = false;
      this.commit(createInitialState(threshold));
    }
  }

  /** Local slider updates. The beacon is told from `writeThreshold`. */
  setThreshold(meters: number): void {
    this.commit({ ...this.state, thresholdMeters: clampThreshold(meters) });
  }

  async writeThreshold(): Promise<void> {
    if (!this.transport || this.state.connection !== "connected") return;
    const meters = this.state.thresholdMeters;
    try {
      await this.transport.writeCommand({
        type: CmdType.SET_THRESHOLD,
        targetId: BROADCAST_ID,
        thresholdMeters: meters,
      });
      this.commit(this.state, {
        id: nextId(),
        at: Date.now(),
        kind: "threshold",
        meters,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not set the separation line.";
      this.commit({ ...this.state, error: message }, { id: nextId(), at: Date.now(), kind: "error", message });
    }
  }

  /** Appendix C: send_check_in. The Heltec leader treats this as the whole group. */
  async sendCheckIn(targetId: number): Promise<void> {
    if (!this.transport || this.state.connection !== "connected") {
      throw new Error("Connect the beacon before sending a check-in.");
    }
    try {
      await this.transport.writeCommand({
        type: CmdType.CHECK_IN,
        targetId,
        thresholdMeters: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check-in did not reach the beacon.";
      this.commit(
        { ...this.state, error: message },
        { id: nextId(), at: Date.now(), kind: "error", message },
      );
      throw error instanceof Error ? error : new Error(message);
    }
    const now = Date.now();
    this.commit(
      { ...this.state, groupCheckInAt: now, groupOkAt: null, error: null },
      { id: nextId(), at: now, kind: "checkin" },
    );
  }

  /** Appendix C: parse_data. One BLE notification in, one state update out. */
  async parseData(event: BleEvent): Promise<void> {
    switch (event.type) {
      case "connected":
        this.commit(
          {
            ...this.state,
            connection: "connected",
            error: null,
            deviceName: event.deviceName,
          },
          {
            id: nextId(),
            at: Date.now(),
            kind: "linked",
            message: event.deviceName,
          },
        );
        return;
      case "disconnected":
        if (this.closing || !event.unexpected) return;
        this.commit({
          ...this.state,
          connection: "disconnected",
          error: "The beacon link dropped. The last distances are still on screen.",
        });
        return;
      case "reconnecting":
        this.commit({ ...this.state, connection: "reconnecting", error: null });
        return;
      case "error":
        this.commit(
          { ...this.state, error: event.message },
          { id: nextId(), at: Date.now(), kind: "error", message: event.message },
        );
        return;
      case "leader":
        this.commit({
          ...this.state,
          leaderBatteryPercent: event.batteryPercent,
          lastPacketAt: Date.now(),
        });
        return;
      case "follower":
        this.upsertFollower(event.info, event.lab ?? null);
        return;
      case "alert":
        this.triggerAlert(event.deviceId, event.status);
        return;
      case "roster-cleared":
        this.commit(
          { ...this.state, members: [], alerts: [] },
          { id: nextId(), at: Date.now(), kind: "cleared" },
        );
        return;
      case "live": {
        const now = Date.now();
        const followerOk = isFollowerOkSignal(event.text);
        const distance =
          event.distanceM != null && Number.isFinite(event.distanceM) ? event.distanceM : null;
        this.commit(
          {
            ...this.state,
            lastPacketAt: now,
            groupOkAt: followerOk ? now : this.state.groupOkAt,
            uwbDistanceM: distance ?? this.state.uwbDistanceM,
            liveLink: {
              counter: event.counter ?? this.state.liveLink?.counter ?? null,
              text: event.text ?? this.state.liveLink?.text ?? null,
              packetCount: (this.state.liveLink?.packetCount ?? 0) + 1,
              lastHex: event.hex,
            },
          },
          followerOk ? { id: nextId(), at: now, kind: "answered" } : undefined,
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * Appendix C: trigger_alert.
   * Called for the alert characteristic and when a follower status first
   * enters Need Help or Out of range. A repeat of the same alert is ignored
   * so a 2 s refresh does not re-page the leader.
   */
  triggerAlert(deviceId: number, status: Status): void {
    if (status !== Status.NEED_HELP && status !== Status.OUT_OF_RANGE) return;
    const existing = this.state.alerts.find((alert) => alert.deviceId === deviceId);
    if (existing?.status === status) return;
    const at = Date.now();
    const alerts: ActiveAlert[] = [
      ...this.state.alerts.filter((alert) => alert.deviceId !== deviceId),
      { deviceId, status, at },
    ];
    this.commit(
      { ...this.state, alerts },
      {
        id: nextId(),
        at,
        kind: status === Status.NEED_HELP ? "help" : "separated",
        deviceId,
      },
    );
  }

  dismissError(): void {
    if (!this.state.error) return;
    this.commit({ ...this.state, error: null });
  }

  private upsertFollower(info: FollowerInfo, lab: LabSample | null): void {
    const now = Date.now();
    const previous = this.state.members.find((member) => member.deviceId === info.deviceId);
    const pendingSince =
      info.status === Status.CHECKIN_PENDING
        ? (previous?.pendingSince ?? previous?.checkInSentAt ?? now)
        : null;

    // A periodic OK refresh must not wipe a check-in this phone just sent.
    // Clear it only when the beacon actually leaves an alarm or a pending check-in.
    let checkInSentAt = previous?.checkInSentAt ?? null;
    if (info.status === Status.CHECKIN_PENDING) {
      checkInSentAt = previous?.checkInSentAt ?? now;
    } else if (info.status === Status.OK && previous && previous.status !== Status.OK) {
      checkInSentAt = null;
    }

    const next: MemberState = {
      deviceId: info.deviceId,
      status: info.status,
      batteryPercent: info.batteryPercent,
      distanceM: info.distanceM,
      angleDeg: info.angleDeg,
      uwbOutOfRange: info.uwbOutOfRange,
      lastDistanceM: info.distanceM ?? previous?.lastDistanceM ?? null,
      lastAngleDeg: info.angleDeg ?? previous?.lastAngleDeg ?? null,
      pendingSince,
      checkInSentAt,
      updatedAt: now,
      lab,
    };

    let alerts = this.state.alerts;
    let activity: ActivityEntry | undefined;

    if (info.status === Status.OK && previous && previous.status !== Status.OK) {
      alerts = alerts.filter((alert) => alert.deviceId !== info.deviceId);
      if (
        previous.status === Status.CHECKIN_PENDING ||
        previous.status === Status.NEED_HELP ||
        previous.checkInSentAt
      ) {
        activity = { id: nextId(), at: now, kind: "answered", deviceId: info.deviceId };
      } else if (previous.status === Status.OUT_OF_RANGE) {
        activity = { id: nextId(), at: now, kind: "returned", deviceId: info.deviceId };
      }
    }

    const members = [
      ...this.state.members.filter((member) => member.deviceId !== info.deviceId),
      next,
    ].sort((a, b) => a.deviceId - b.deviceId);

    this.commit({ ...this.state, members, alerts, lastPacketAt: now }, activity);

    if (info.status === Status.NEED_HELP || info.status === Status.OUT_OF_RANGE) {
      this.triggerAlert(info.deviceId, info.status);
    }
  }

  private release(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.transport = null;
  }

  private commit(next: AppState, activity?: ActivityEntry): void {
    this.state = activity
      ? { ...next, activity: [activity, ...next.activity].slice(0, 24) }
      : next;
    for (const listener of this.listeners) listener(this.state);
  }
}

function nextId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
