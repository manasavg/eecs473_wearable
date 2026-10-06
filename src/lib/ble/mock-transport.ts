import { CYCLE_MS, MISSED_PINGS_LIMIT, SUSTAINED_OVER_THRESHOLD_CYCLES, UWB_RANGE_M } from "./constants";
import { decideRange, wrapAngle } from "./ranging";
import type { BleEvent, BleTransport } from "./transport";
import { CmdType, Status, type AppCommand, type FollowerInfo } from "./types";

/**
 * Demo trail. Stands in for the leader beacon until the ESP32 GATT server is up.
 *
 * The dashboard cannot tell these events from real notifications, except for
 * the optional `lab` sample (missed-ping count), which the wire format does
 * not carry yet.
 *
 * Button names in the Field test sheet match the wristband:
 *   - 3-second press while no check-in is active → Need Help
 *   - response button → I'm OK, and it clears a check-in
 */

export interface DemoControls {
  setDistance(id: number, meters: number): void;
  nudgeDistance(id: number, deltaMeters: number): void;
  addMisses(id: number, count: number): void;
  restoreUwb(id: number): void;
  pressNeedHelp(id: number): void;
  pressOk(id: number): void;
  addWristband(): void;
  forgetWristbands(): void;
  holdSync(): void;
  tripSeparation(id: number): void;
  setFollowerBattery(id: number, percent: number): void;
  setLeaderBattery(percent: number): void;
  setDrift(on: boolean): void;
}

interface SimFollower {
  deviceId: number;
  distanceM: number | null;
  angleDeg: number | null;
  batteryPercent: number;
  missedPings: number;
  overThresholdCount: number;
  needHelp: boolean;
  checkInPending: boolean;
}

export class MockTrailTransport implements BleTransport, DemoControls {
  private listeners = new Set<(event: BleEvent) => void>();
  private followers = new Map<number, SimFollower>();
  private lastStatus = new Map<number, Status>();
  private leaderBattery = 91;
  private thresholdM = 40;
  private timer: ReturnType<typeof setInterval> | null = null;
  private drift = false;

  subscribe(listener: (event: BleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.emit({ type: "connected", deviceName: "Demo trail" });
    this.holdSync();
    this.timer = setInterval(() => this.cycle(), CYCLE_MS);
    const timer = this.timer as { unref?: () => void };
    timer.unref?.();
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit({ type: "disconnected", unexpected: false });
  }

  async writeCommand(command: AppCommand): Promise<void> {
    if (command.type === CmdType.SET_THRESHOLD) {
      this.thresholdM = command.thresholdMeters;
      this.publishAll();
      return;
    }
    const ids =
      command.targetId === 0xff ? [...this.followers.keys()] : [command.targetId];
    for (const id of ids) {
      const follower = this.followers.get(id);
      if (!follower) continue;
      follower.checkInPending = true;
      this.publishOne(follower);
    }
  }

  setDistance(id: number, meters: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    const clamped = Math.max(0.5, Math.min(UWB_RANGE_M, meters));
    follower.distanceM = clamped;
    follower.angleDeg = follower.angleDeg ?? 0;
    follower.missedPings = 0;
    this.publishOne(follower);
  }

  nudgeDistance(id: number, deltaMeters: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    const base = follower.distanceM ?? 12;
    this.setDistance(id, base + deltaMeters);
  }

  addMisses(id: number, count: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    follower.missedPings = Math.min(MISSED_PINGS_LIMIT, follower.missedPings + count);
    if (follower.missedPings >= MISSED_PINGS_LIMIT) {
      follower.distanceM = null;
      follower.angleDeg = null;
    }
    this.publishOne(follower);
  }

  restoreUwb(id: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    follower.missedPings = 0;
    follower.distanceM = follower.distanceM ?? 16;
    follower.angleDeg = follower.angleDeg ?? 0;
    this.publishOne(follower);
  }

  pressNeedHelp(id: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    follower.needHelp = true;
    this.publishOne(follower);
  }

  pressOk(id: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    follower.needHelp = false;
    follower.checkInPending = false;
    this.publishOne(follower);
  }

  addWristband(): void {
    const nextId = this.followers.size === 0 ? 1 : Math.max(...this.followers.keys()) + 1;
    if (nextId > 8) return;
    const side = nextId % 2 === 0 ? 1 : -1;
    this.followers.set(
      nextId,
      createFollower(nextId, 10 + nextId * 4, wrapAngle(side * 15 * nextId), 80 - nextId * 3),
    );
    this.publishOne(this.followers.get(nextId)!);
  }

  forgetWristbands(): void {
    this.followers.clear();
    this.lastStatus.clear();
    this.emit({ type: "roster-cleared" });
    this.emit({ type: "leader", batteryPercent: this.leaderBattery });
  }

  holdSync(): void {
    if (!this.followers.has(1)) {
      this.followers.set(1, createFollower(1, 12.4, -18, 88));
    }
    if (!this.followers.has(2)) {
      this.followers.set(2, createFollower(2, 28.6, 42, 64));
    }
    this.publishAll();
  }

  tripSeparation(id: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    if (this.thresholdM >= UWB_RANGE_M) {
      this.addMisses(id, MISSED_PINGS_LIMIT);
      return;
    }
    follower.needHelp = false;
    follower.missedPings = 0;
    follower.distanceM = Math.min(UWB_RANGE_M - 0.1, this.thresholdM + 3);
    follower.angleDeg = follower.angleDeg ?? 24;
    follower.overThresholdCount = SUSTAINED_OVER_THRESHOLD_CYCLES - 1;
    this.publishOne(follower);
  }

  setFollowerBattery(id: number, percent: number): void {
    const follower = this.followers.get(id);
    if (!follower) return;
    follower.batteryPercent = clampPercent(percent);
    this.publishOne(follower);
  }

  setLeaderBattery(percent: number): void {
    this.leaderBattery = clampPercent(percent);
    this.emit({ type: "leader", batteryPercent: this.leaderBattery });
  }

  setDrift(on: boolean): void {
    this.drift = on;
  }

  private cycle(): void {
    if (this.drift) this.wander();
    this.publishAll();
  }

  private wander(): void {
    for (const follower of this.followers.values()) {
      if (follower.distanceM == null) continue;
      follower.distanceM = Math.max(0.8, follower.distanceM + (Math.random() - 0.48) * 1.1);
      follower.angleDeg = wrapAngle((follower.angleDeg ?? 0) + (Math.random() - 0.5) * 6);
      if (follower.distanceM > UWB_RANGE_M) {
        follower.distanceM = UWB_RANGE_M;
        follower.missedPings = Math.min(MISSED_PINGS_LIMIT, follower.missedPings + 1);
        if (follower.missedPings >= MISSED_PINGS_LIMIT) {
          follower.distanceM = null;
          follower.angleDeg = null;
        }
      }
      if (Math.random() < 0.25) {
        follower.batteryPercent = Math.max(4, follower.batteryPercent - 1);
      }
    }
    if (Math.random() < 0.2) {
      this.leaderBattery = Math.max(4, this.leaderBattery - 1);
    }
  }

  private publishAll(): void {
    for (const follower of this.followers.values()) this.publishOne(follower);
    this.emit({ type: "leader", batteryPercent: this.leaderBattery });
  }

  private publishOne(follower: SimFollower): void {
    const decision = decideRange({
      distanceM: follower.distanceM,
      angleDeg: follower.angleDeg,
      missedPings: follower.missedPings,
      overThresholdCount: follower.overThresholdCount,
      thresholdM: this.thresholdM,
      needHelp: follower.needHelp,
      checkInPending: follower.checkInPending,
    });
    follower.overThresholdCount = decision.overThresholdCount;
    const info: FollowerInfo = {
      deviceId: follower.deviceId,
      status: decision.status,
      batteryPercent: follower.batteryPercent,
      distanceM: decision.distanceM,
      angleDeg: decision.angleDeg,
      uwbOutOfRange: decision.uwbOutOfRange,
    };
    const previous = this.lastStatus.get(follower.deviceId);
    this.lastStatus.set(follower.deviceId, info.status);
    this.emit({
      type: "follower",
      info,
      lab: {
        missedPings: follower.missedPings,
        overThresholdCount: follower.overThresholdCount,
      },
    });
    if (
      (info.status === Status.NEED_HELP || info.status === Status.OUT_OF_RANGE) &&
      previous !== info.status
    ) {
      this.emit({
        type: "alert",
        deviceId: follower.deviceId,
        status: info.status,
        uwbOutOfRange: info.uwbOutOfRange,
      });
    }
  }

  private emit(event: BleEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function createFollower(
  deviceId: number,
  distanceM: number,
  angleDeg: number,
  batteryPercent: number,
): SimFollower {
  return {
    deviceId,
    distanceM,
    angleDeg,
    batteryPercent,
    missedPings: 0,
    overThresholdCount: 0,
    needHelp: false,
    checkInPending: false,
  };
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}
