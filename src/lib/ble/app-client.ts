import { haversineMeters, isOutOfRange } from "../geo";
import {
  BROADCAST_ID,
  CHECK_IN_TIMEOUT_MS,
  DEFAULT_SILENCE_S,
  DEFAULT_THRESHOLD_M,
  clampSilence,
} from "./constants";
import { createTransport, type LinkMode } from "./create-transport";
import { isFollowerOkSignal } from "./live-link";
import { clampThreshold } from "./protocol";
import type { BleEvent, BlePeer, BleTransport } from "./transport";
import type { BoardPlan, BoardSettings } from "../meshtastic/setup";
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

/**
 * sending → waiting → received → ok.
 * received: the board's radio acknowledged it; nobody has pressed OK yet.
 * ok: someone pressed the OK button (or the radio acknowledged, when no press is required).
 * unconfirmed: the board received it, but nobody pressed OK in time.
 */
export type CheckInStatus =
  | "sending"
  | "waiting"
  | "received"
  | "ok"
  | "unconfirmed"
  | "noAnswer"
  | "failed";

/** The latest CHECK IN sent to one board. */
export interface FollowerCheckIn {
  status: CheckInStatus;
  sentAt: number;
  /** Meshtastic packet id, once the leader queued it. */
  packetId: number | null;
  /** When the board's radio acknowledged it. */
  receivedAt: number | null;
  answeredAt: number | null;
  /** "person" when someone pressed OK, "radio" when the acknowledgement alone counted. */
  confirmedBy: "person" | "radio" | null;
  /** Why it failed, for No answer and failed. */
  reason: string | null;
}

/** A board the team owns. Saved on the phone. */
export interface GroupMember {
  id: number;
  name: string;
}

/** With an empty group every board heard is shown. Otherwise only members are followers. */
export function isInGroup(state: Pick<AppState, "group">, id: number): boolean {
  return state.group.length === 0 || state.group.some((member) => member.id === id);
}

export interface BoardSetupState {
  status: "idle" | "working" | "done" | "error";
  message: string | null;
}

/** The newest valid GPS fix a board reported. Kept through fix loss, silence and reconnects. */
export interface LastKnown {
  lat: number;
  lon: number;
  /** When that position was taken, or when the phone received it if the radio had no clock. */
  at: number;
}

/** One of the other boards, tracked by the leader the phone is connected to. */
export interface TrackedFollower {
  id: number;
  /** Meshtastic long name, when the radio has one. */
  name: string | null;
  fix: boolean | null;
  lat: number | null;
  lon: number | null;
  separationKnown: boolean | null;
  separationM: number | null;
  outOfRange: boolean;
  /** When the leader last heard anything from this board. */
  lastHeardAt: number | null;
  /** When the shown position was taken. */
  positionAt: number | null;
  /** Not heard for longer than silenceSeconds. Its distance is stale. */
  silent: boolean;
  checkIn: FollowerCheckIn | null;
  lastKnown: LastKnown | null;
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
  /** Flag a follower that has been silent this long. */
  silenceSeconds: number;
  /** A check-in needs someone to press OK on the board, not just the radio's acknowledgement. */
  requireConfirm: boolean;
  /** The connected board's own settings, once it reports them. */
  board: BoardSettings | null;
  /** Node number of the connected board. It is never listed as a follower. */
  leaderId: number | null;
  /** The team's boards. Empty means show every board heard. */
  group: GroupMember[];
  boardSetup: BoardSetupState;
  /** When this link came up. Silence counts from here for a board never heard. */
  connectedAt: number | null;
  members: MemberState[];
  alerts: ActiveAlert[];
  activity: ActivityEntry[];
  lastPacketAt: number | null;
  liveLink: LiveLink | null;
  /** When the check-in write reached the leader. The app is waiting for a follower OK. */
  groupCheckInAt: number | null;
  /** When the leader notified that a follower pressed OK. */
  groupOkAt: number | null;
  /** Board id from that OK, when the radio included one. */
  groupOkId: number | null;
  /** Every follower that acknowledged this check-in. */
  okIds: number[];
  /** Null until the first GPS packet. False when the NEO-6M has not locked. */
  gpsFix: boolean | null;
  gpsLat: number | null;
  gpsLon: number | null;
  /** When the leader's position was taken. */
  gpsAt: number | null;
  /** The other boards. Empty until the leader hears one. */
  followers: TrackedFollower[];
  /** Mirrors followers[0] so a single-follower reading still has one distance. */
  separationKnown: boolean | null;
  separationM: number | null;
  followerFix: boolean | null;
  followerLat: number | null;
  followerLon: number | null;
  /** True when any follower is farther than thresholdMeters. */
  outOfRange: boolean;
}

export function createInitialState(
  thresholdMeters = DEFAULT_THRESHOLD_M,
  silenceSeconds = DEFAULT_SILENCE_S,
  requireConfirm = true,
): AppState {
  return {
    mode: "idle",
    connection: "disconnected",
    error: null,
    deviceName: null,
    leaderBatteryPercent: null,
    thresholdMeters: clampThreshold(thresholdMeters),
    silenceSeconds: clampSilence(silenceSeconds),
    requireConfirm,
    board: null,
    leaderId: null,
    group: [],
    boardSetup: { status: "idle", message: null },
    connectedAt: null,
    members: [],
    alerts: [],
    activity: [],
    lastPacketAt: null,
    liveLink: null,
    groupCheckInAt: null,
    groupOkAt: null,
    groupOkId: null,
    okIds: [],
    gpsFix: null,
    gpsLat: null,
    gpsLon: null,
    gpsAt: null,
    followers: [],
    separationKnown: null,
    separationM: null,
    followerFix: null,
    followerLat: null,
    followerLon: null,
    outOfRange: false,
  };
}

function projectFollowers(state: AppState, followers: TrackedFollower[], now: number): AppState {
  const roster = withRoster(followers, state);
  const marked = markSilence(roster, now, state.silenceSeconds, state.connectedAt);
  const primary = marked[0] ?? null;
  return {
    ...state,
    followers: marked,
    followerFix: primary?.fix ?? null,
    followerLat: primary?.lat ?? null,
    followerLon: primary?.lon ?? null,
    separationKnown: primary?.separationKnown ?? null,
    separationM: primary?.separationM ?? null,
    outOfRange: marked.some((follower) => follower.outOfRange && isInGroup(state, follower.id)),
  };
}

/**
 * Drop the leader from the list, and add a card for each group member not heard yet,
 * so a missing board shows up as missing instead of not at all.
 */
function withRoster(followers: TrackedFollower[], state: AppState): TrackedFollower[] {
  const list = state.leaderId == null ? followers : followers.filter((item) => item.id !== state.leaderId);
  const missing = state.group.filter(
    (member) => member.id !== state.leaderId && !list.some((item) => item.id === member.id),
  );
  if (missing.length === 0) return list;
  return [...list, ...missing.map((member) => emptyFollower(member.id, member.name))].sort((a, b) => a.id - b.id);
}

function emptyFollower(id: number, name: string | null): TrackedFollower {
  return {
    id,
    name,
    fix: null,
    lat: null,
    lon: null,
    separationKnown: null,
    separationM: null,
    outOfRange: false,
    lastHeardAt: null,
    positionAt: null,
    silent: false,
    checkIn: null,
    lastKnown: null,
  };
}

/** Flag each follower the leader has not heard from within the silence limit. */
function markSilence(
  followers: TrackedFollower[],
  now: number,
  silenceSeconds: number,
  connectedAt: number | null,
): TrackedFollower[] {
  return followers.map((follower) => {
    const since = follower.lastHeardAt ?? connectedAt;
    const silent = since != null && now - since > silenceSeconds * 1000;
    return silent === follower.silent ? follower : { ...follower, silent };
  });
}

/** Turn a check-in that has waited too long into No answer, or No OK pressed if the board got it. */
function expireCheckIns(followers: TrackedFollower[], now: number): TrackedFollower[] {
  return followers.map((follower) => {
    const checkIn = follower.checkIn;
    if (!checkIn || now - checkIn.sentAt <= CHECK_IN_TIMEOUT_MS) return follower;
    if (checkIn.status === "received") {
      return {
        ...follower,
        checkIn: { ...checkIn, status: "unconfirmed", reason: "The board got it, but nobody pressed OK" },
      };
    }
    if (checkIn.status !== "sending" && checkIn.status !== "waiting") return follower;
    return { ...follower, checkIn: { ...checkIn, status: "noAnswer", reason: "No answer" } };
  });
}

function patchCheckIn(
  followers: TrackedFollower[],
  id: number,
  update: (checkIn: FollowerCheckIn) => FollowerCheckIn | null,
): TrackedFollower[] {
  return followers.map((follower) => {
    if (follower.id !== id || !follower.checkIn) return follower;
    const next = update(follower.checkIn);
    return next ? { ...follower, checkIn: next } : follower;
  });
}

/**
 * Record each follower's newest valid fix. A lost fix or a silent board keeps the old one.
 * `remembered` carries fixes across reconnects and app restarts, and is updated in place.
 */
function updateLastKnown(
  followers: TrackedFollower[],
  remembered: Map<number, LastKnown>,
  now: number,
): TrackedFollower[] {
  return followers.map((follower) => {
    let known = follower.lastKnown ?? remembered.get(follower.id) ?? null;
    if (follower.fix === true && follower.lat != null && follower.lon != null) {
      const moved = !known || known.lat !== follower.lat || known.lon !== follower.lon;
      const newer = follower.positionAt != null && (!known || follower.positionAt > known.at);
      if (moved || newer) {
        const at = follower.positionAt ?? now;
        // Never replace a fix with an older one, for example a stale database entry on connect.
        if (!known || at >= known.at) known = { lat: follower.lat, lon: follower.lon, at };
      }
    }
    if (known) remembered.set(follower.id, known);
    return known === follower.lastKnown ? follower : { ...follower, lastKnown: known };
  });
}

function latest(a: number | null, b: number | null | undefined): number | null {
  if (b == null) return a;
  if (a == null) return b;
  return Math.max(a, b);
}

function upsertTracked(
  followers: TrackedFollower[],
  id: number,
  patch: Partial<Omit<TrackedFollower, "id" | "outOfRange" | "silent">>,
  thresholdMeters: number,
): TrackedFollower[] {
  const previous = followers.find((follower) => follower.id === id);
  const next: TrackedFollower = {
    id,
    name: patch.name !== undefined ? patch.name : (previous?.name ?? null),
    fix: patch.fix !== undefined ? patch.fix : (previous?.fix ?? null),
    lat: patch.lat !== undefined ? patch.lat : (previous?.lat ?? null),
    lon: patch.lon !== undefined ? patch.lon : (previous?.lon ?? null),
    separationKnown:
      patch.separationKnown !== undefined ? patch.separationKnown : (previous?.separationKnown ?? null),
    separationM: patch.separationM !== undefined ? patch.separationM : (previous?.separationM ?? null),
    outOfRange: false,
    lastHeardAt: latest(previous?.lastHeardAt ?? null, patch.lastHeardAt),
    positionAt: patch.positionAt !== undefined ? patch.positionAt : (previous?.positionAt ?? null),
    silent: previous?.silent ?? false,
    checkIn: patch.checkIn !== undefined ? patch.checkIn : (previous?.checkIn ?? null),
    lastKnown: previous?.lastKnown ?? null,
  };
  next.outOfRange = isOutOfRange(next.separationKnown, next.separationM, thresholdMeters);
  return [...followers.filter((follower) => follower.id !== id), next].sort((a, b) => a.id - b.id);
}

/** Meters between the leader fix and each follower fix. Meshtastic reports the coordinates. */
function fillDistance(
  followers: TrackedFollower[],
  gpsFix: boolean | null,
  gpsLat: number | null,
  gpsLon: number | null,
  thresholdMeters: number,
): TrackedFollower[] {
  return followers.map((follower) => {
    // A lost fix on either end makes the last distance meaningless. Do not keep showing it.
    if (gpsFix === false || follower.fix === false) {
      return { ...follower, separationKnown: false, separationM: null, outOfRange: false };
    }
    if (gpsFix !== true || gpsLat == null || gpsLon == null) return follower;
    if (follower.fix !== true || follower.lat == null || follower.lon == null) return follower;
    const meters = haversineMeters(gpsLat, gpsLon, follower.lat, follower.lon);
    return {
      ...follower,
      separationKnown: true,
      separationM: meters,
      outOfRange: isOutOfRange(true, meters, thresholdMeters),
    };
  });
}

export class ExcursionAppClient {
  private state: AppState;
  private transport: BleTransport | null = null;
  private scanLink: BleTransport | null = null;
  private scanStop: (() => void) | null = null;
  private scanGeneration = 0;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(state: AppState) => void>();
  private closing = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly remembered = new Map<number, LastKnown>();

  constructor(initial?: {
    thresholdMeters?: number;
    silenceSeconds?: number;
    requireConfirm?: boolean;
    now?: () => number;
  }) {
    this.state = createInitialState(
      initial?.thresholdMeters,
      initial?.silenceSeconds,
      initial?.requireConfirm ?? true,
    );
    this.now = initial?.now ?? Date.now;
  }

  private fresh(): AppState {
    return {
      ...createInitialState(this.state.thresholdMeters, this.state.silenceSeconds, this.state.requireConfirm),
      group: this.state.group,
    };
  }

  /** Replace the team's boards. Members not heard yet get an empty card. */
  setGroup(group: GroupMember[]): void {
    const unique = [...new Map(group.map((member) => [member.id >>> 0, { ...member, id: member.id >>> 0 }])).values()];
    const next = { ...this.state, group: unique };
    const now = this.now();
    const followers = updateLastKnown(withRoster(this.state.followers, next), this.remembered, now);
    this.commit(projectFollowers(next, followers, now));
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
   * Appendix C: connect_device.
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
      ...this.fresh(),
      mode,
      connection: "scanning",
      thresholdMeters: this.state.thresholdMeters,
    });

    try {
      await link.connect(remembered, peer);
      await this.writeThreshold();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not connect.";
      const failed = this.transport;
      this.release();
      void failed?.disconnect();
      this.commit({
        ...this.fresh(),
        connection: "error",
        error: message,
        thresholdMeters: this.state.thresholdMeters,
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
      this.commit(this.fresh());
    }
  }

  /** Local range. The beacon is told from `writeThreshold`. */
  setThreshold(meters: number): void {
    const thresholdMeters = clampThreshold(meters);
    const followers = this.state.followers.map((follower) => ({
      ...follower,
      outOfRange: isOutOfRange(follower.separationKnown, follower.separationM, thresholdMeters),
    }));
    this.commit(projectFollowers({ ...this.state, thresholdMeters }, followers, this.now()));
  }

  /** Last known fixes saved from an earlier session. A newer fix replaces each one. */
  rememberLastKnown(saved: Record<number, LastKnown>): void {
    for (const [key, known] of Object.entries(saved)) {
      const id = Number(key);
      const current = this.remembered.get(id);
      if (!current || known.at > current.at) this.remembered.set(id, known);
    }
    const followers = updateLastKnown(this.state.followers, this.remembered, this.now());
    this.commit(projectFollowers(this.state, followers, this.now()));
  }

  /** Every board's last known fix, including boards not tracked right now. */
  getLastKnown(): Record<number, LastKnown> {
    return Object.fromEntries(this.remembered);
  }

  /** How long a follower may stay silent before it is flagged. */
  setSilenceSeconds(seconds: number): void {
    const silenceSeconds = clampSilence(seconds);
    this.commit(projectFollowers({ ...this.state, silenceSeconds }, this.state.followers, this.now()));
  }

  /**
   * Re-check silence and check-in timeouts. Runs every few seconds while connected.
   * Tests call it directly with their own clock.
   */
  tick(): void {
    if (this.state.connection !== "connected" && this.state.connection !== "reconnecting") return;
    const now = this.now();
    const next = projectFollowers(this.state, expireCheckIns(this.state.followers, now), now);
    const changed = next.followers.some((follower, index) => follower !== this.state.followers[index]);
    if (changed) this.commit(next);
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
        at: this.now(),
        kind: "threshold",
        meters,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not set the separation line.";
      this.commit({ ...this.state, error: message }, { id: nextId(), at: this.now(), kind: "error", message });
    }
  }

  /**
   * CHECK IN to one follower, or to every follower for BROADCAST_ID.
   * Each board's answer is tracked on its own card.
   */
  async sendCheckIn(targetId: number): Promise<void> {
    if (!this.transport || this.state.connection !== "connected") {
      throw new Error("Connect the beacon before sending a check-in.");
    }
    const targets =
      targetId === BROADCAST_ID
        ? this.state.followers
            .filter((follower) => isInGroup(this.state, follower.id))
            .map((follower) => follower.id)
        : this.state.followers.some((follower) => follower.id === targetId)
          ? [targetId]
          : [];
    if (targets.length > 0) {
      await this.sendTrackedCheckIns(targets);
      return;
    }
    await this.sendGroupCheckIn(targetId);
  }

  private async sendTrackedCheckIns(targets: number[]): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const sentAt = this.now();
    let followers = this.state.followers;
    for (const id of targets) {
      followers = upsertTracked(
        followers,
        id,
        {
          checkIn: {
            status: "sending",
            sentAt,
            packetId: null,
            receivedAt: null,
            answeredAt: null,
            confirmedBy: null,
            reason: null,
          },
        },
        this.state.thresholdMeters,
      );
    }
    this.commit(projectFollowers({ ...this.state, error: null }, followers, sentAt), {
      id: nextId(),
      at: sentAt,
      kind: "checkin",
      ...(targets.length === 1 ? { deviceId: targets[0] } : {}),
    });

    let firstError: Error | null = null;
    for (const id of targets) {
      try {
        await transport.writeCommand({ type: CmdType.CHECK_IN, targetId: id, thresholdMeters: 0 });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Check-in did not reach the beacon.");
        firstError ??= failure;
        this.commit(
          projectFollowers(
            this.state,
            patchCheckIn(this.state.followers, id, (checkIn) =>
              checkIn.sentAt === sentAt ? { ...checkIn, status: "failed", reason: failure.message } : null,
            ),
            this.now(),
          ),
        );
      }
    }
    if (firstError && targets.length === 1) throw firstError;
  }

  /** The old firmware's single group check-in, used when no follower is tracked yet. */
  private async sendGroupCheckIn(targetId: number): Promise<void> {
    if (!this.transport) return;
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
        { id: nextId(), at: this.now(), kind: "error", message },
      );
      throw error instanceof Error ? error : new Error(message);
    }
    const now = this.now();
    this.commit(
      { ...this.state, groupCheckInAt: now, groupOkAt: null, groupOkId: null, okIds: [], error: null },
      { id: nextId(), at: now, kind: "checkin" },
    );
  }

  /** Appendix C: parse_data. One BLE notification in, one state update out. */
  async parseData(event: BleEvent): Promise<void> {
    switch (event.type) {
      case "connected":
        this.commit(
          projectFollowers(
            {
              ...this.state,
              connection: "connected",
              error: null,
              deviceName: event.deviceName,
              connectedAt: this.state.connectedAt ?? this.now(),
            },
            updateLastKnown(withRoster(this.state.followers, this.state), this.remembered, this.now()),
            this.now(),
          ),
          {
            id: nextId(),
            at: this.now(),
            kind: "linked",
            message: event.deviceName,
          },
        );
        this.startTicker();
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
        this.commit(
          { ...this.state, error: event.message },
          { id: nextId(), at: this.now(), kind: "error", message: event.message },
        );
        return;
      case "leader":
        this.commit({
          ...this.state,
          leaderBatteryPercent: event.batteryPercent,
          lastPacketAt: this.now(),
        });
        return;
      case "follower":
        this.upsertFollower(event.info, event.lab ?? null);
        return;
      case "alert":
        this.triggerAlert(event.deviceId, event.status);
        return;
      case "my-node": {
        const next = { ...this.state, leaderId: event.id };
        this.commit(projectFollowers(next, this.state.followers, this.now()));
        return;
      }
      case "node-seen": {
        const exists = this.state.followers.some((follower) => follower.id === event.id);
        const followers = updateLastKnown(
          upsertTracked(
            this.state.followers,
            event.id,
            {
              ...(exists ? {} : { name: event.name }),
              ...(event.at != null ? { lastHeardAt: Math.min(event.at, this.now()) } : {}),
            },
            this.state.thresholdMeters,
          ),
          this.remembered,
          this.now(),
        );
        this.commit(projectFollowers({ ...this.state, lastPacketAt: this.now() }, followers, this.now()));
        return;
      }
      case "board-settings":
        this.commit({ ...this.state, board: event.settings });
        return;
      case "heard": {
        if (!this.state.followers.some((follower) => follower.id === event.id)) return;
        const followers = this.state.followers.map((follower) =>
          follower.id === event.id
            ? { ...follower, lastHeardAt: latest(follower.lastHeardAt, Math.min(event.at, this.now())) }
            : follower,
        );
        this.commit(projectFollowers({ ...this.state, lastPacketAt: this.now() }, followers, this.now()));
        return;
      }
      case "checkin-sent":
        this.commit(
          projectFollowers(
            this.state,
            patchCheckIn(this.state.followers, event.id, (checkIn) =>
              checkIn.status === "sending" ? { ...checkIn, status: "waiting", packetId: event.packetId } : null,
            ),
            this.now(),
          ),
        );
        return;
      case "checkin-ack":
        this.receiveCheckIn(event.id, event.packetId);
        return;
      case "checkin-failed":
        this.commit(
          projectFollowers(
            this.state,
            patchCheckIn(this.state.followers, event.id, (checkIn) =>
              checkIn.packetId === event.packetId &&
              (checkIn.status === "sending" || checkIn.status === "waiting")
                ? { ...checkIn, status: event.noAnswer ? "noAnswer" : "failed", reason: event.reason }
                : null,
            ),
            this.now(),
          ),
        );
        return;
      case "roster-cleared":
        this.commit(
          { ...this.state, members: [], alerts: [] },
          { id: nextId(), at: this.now(), kind: "cleared" },
        );
        return;
      case "live": {
        const now = this.now();
        const followerOk = isFollowerOkSignal(event.text);
        const gps = event.gps;
        let followers = this.state.followers;
        if (event.followerGoneId != null) {
          followers = followers.filter((follower) => follower.id !== event.followerGoneId);
        }
        if (event.followerGps) {
          followers = upsertTracked(
            followers,
            event.followerGps.id ?? 0,
            {
              fix: event.followerGps.fix,
              lat: event.followerGps.lat,
              lon: event.followerGps.lon,
              ...(event.followerGps.name ? { name: event.followerGps.name } : {}),
              ...(event.followerGps.heardAt != null ? { lastHeardAt: event.followerGps.heardAt } : {}),
              ...(event.followerGps.positionAt !== undefined
                ? { positionAt: event.followerGps.positionAt }
                : {}),
            },
            this.state.thresholdMeters,
          );
        }
        if (event.separation) {
          followers = upsertTracked(
            followers,
            event.separation.id ?? 0,
            {
              separationKnown: event.separation.known,
              separationM: event.separation.meters,
            },
            this.state.thresholdMeters,
          );
        }
        const gpsFix = gps ? gps.fix : this.state.gpsFix;
        const gpsLat = gps ? gps.lat : this.state.gpsLat;
        const gpsLon = gps ? gps.lon : this.state.gpsLon;
        const gpsAt = gps ? (gps.at ?? (gps.fix ? now : null)) : this.state.gpsAt;
        followers = fillDistance(followers, gpsFix, gpsLat, gpsLon, this.state.thresholdMeters);
        followers = updateLastKnown(followers, this.remembered, now);
        this.commit(
          projectFollowers(
            {
              ...this.state,
              lastPacketAt: now,
              groupOkAt: followerOk ? now : this.state.groupOkAt,
              groupOkId: followerOk ? (event.okId ?? this.state.groupOkId) : this.state.groupOkId,
              okIds:
                followerOk && event.okId != null
                  ? [...new Set([...this.state.okIds, event.okId])]
                  : this.state.okIds,
              gpsFix,
              gpsLat,
              gpsLon,
              gpsAt,
              liveLink: {
                counter: event.counter ?? this.state.liveLink?.counter ?? null,
                text: event.text ?? this.state.liveLink?.text ?? null,
                packetCount: (this.state.liveLink?.packetCount ?? 0) + 1,
                lastHex: event.hex,
              },
            },
            followers,
            now,
          ),
          followerOk ? { id: nextId(), at: now, kind: "answered" } : undefined,
        );
        // An OK text from a board counts as its answer, but only to a check-in still open.
        if (followerOk && event.okId != null) this.confirmCheckIn(event.okId);
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
    const at = this.now();
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

  /**
   * The board's own radio acknowledged this packet. That proves the board got it,
   * not that anyone saw it, so it is OK only when no button press is required.
   * A late acknowledgement still counts after No answer was shown.
   */
  private receiveCheckIn(id: number, packetId: number): void {
    const now = this.now();
    const checkIn = this.state.followers.find((follower) => follower.id === id)?.checkIn;
    if (!checkIn || checkIn.packetId !== packetId) return;
    if (checkIn.status !== "sending" && checkIn.status !== "waiting" && checkIn.status !== "noAnswer") return;
    if (!this.state.requireConfirm) {
      this.finishCheckIn(id, "radio", now);
      return;
    }
    const late = now - checkIn.sentAt > CHECK_IN_TIMEOUT_MS;
    this.commit(
      projectFollowers(
        this.state,
        patchCheckIn(this.state.followers, id, (current) => ({
          ...current,
          status: late ? "unconfirmed" : "received",
          receivedAt: now,
          reason: late ? "The board got it, but nobody pressed OK" : null,
        })),
        now,
      ),
    );
  }

  /**
   * Someone on that board sent OK, normally by pressing its OK button.
   * Counts for any check-in still open, even one already shown as No answer.
   */
  private confirmCheckIn(id: number): void {
    const checkIn = this.state.followers.find((follower) => follower.id === id)?.checkIn;
    if (!checkIn || checkIn.status === "ok") return;
    this.finishCheckIn(id, "person", this.now());
  }

  private finishCheckIn(id: number, by: "person" | "radio", now: number): void {
    this.commit(
      projectFollowers(
        this.state,
        patchCheckIn(this.state.followers, id, (current) => ({
          ...current,
          status: "ok",
          receivedAt: current.receivedAt ?? (by === "radio" ? now : null),
          answeredAt: now,
          confirmedBy: by,
          reason: null,
        })),
        now,
      ),
      { id: nextId(), at: now, kind: "answered", deviceId: id },
    );
  }

  /** Write the team settings to the connected board. */
  async setUpBoard(plan: BoardPlan): Promise<void> {
    const transport = this.transport;
    if (!transport || this.state.connection !== "connected") {
      throw new Error("Connect a board before setting it up.");
    }
    if (!transport.setUpBoard) throw new Error("This link cannot change board settings.");
    this.commit({ ...this.state, boardSetup: { status: "working", message: null } });
    try {
      await transport.setUpBoard(plan);
      this.commit({
        ...this.state,
        boardSetup: {
          status: "done",
          message: "Settings sent. If the board restarts, the app reconnects to it.",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The board did not take the settings.";
      this.commit({ ...this.state, boardSetup: { status: "error", message } });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** When on, a check-in is OK only after someone presses the board's OK button. */
  setRequireConfirm(requireConfirm: boolean): void {
    if (requireConfirm === this.state.requireConfirm) return;
    this.commit({ ...this.state, requireConfirm });
  }

  dismissError(): void {
    if (!this.state.error) return;
    this.commit({ ...this.state, error: null });
  }

  private upsertFollower(info: FollowerInfo, lab: LabSample | null): void {
    const now = this.now();
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

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), 5000);
    (this.ticker as { unref?: () => void }).unref?.();
  }

  private release(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
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
