import type { FollowerInfo, LabSample, Status } from "./types";
import type { AppCommand } from "./types";

/** One Heltec the phone can choose. Connecting makes that board the leader. */
export interface BlePeer {
  deviceId: string;
  name: string;
}

/**
 * The only interface the dashboard talks to.
 * Web Bluetooth, the demo trail, and a future iOS stack all implement this.
 */
export type BleEvent =
  | { type: "connected"; deviceName: string }
  | { type: "disconnected"; unexpected: boolean }
  | { type: "reconnecting" }
  | { type: "error"; message: string }
  | { type: "leader"; batteryPercent: number | null }
  | { type: "follower"; info: FollowerInfo; lab?: LabSample }
  | { type: "alert"; deviceId: number; status: Status; uwbOutOfRange: boolean }
  | { type: "roster-cleared" }
  | {
      type: "live";
      counter: number | null;
      text: string | null;
      hex: string;
      gps?: { fix: boolean; lat: number | null; lon: number | null } | null;
      followerGps?: { id?: number; fix: boolean; lat: number | null; lon: number | null } | null;
      separation?: { id?: number; known: boolean; meters: number | null } | null;
      /** Set when a follower LoRa OK includes that board's id. */
      okId?: number | null;
      /** The leader dropped this follower after it stopped answering. */
      followerGoneId?: number | null;
    };

export interface BleTransport {
  connect(remembered?: boolean, peer?: BlePeer): Promise<void>;
  /** Collect Excursion boards until stopScan. The iPhone list uses this. */
  scan?(onPeer: (peer: BlePeer) => void): Promise<void>;
  stopScan?(): Promise<void>;
  disconnect(): Promise<void>;
  writeCommand(command: AppCommand): Promise<void>;
  subscribe(listener: (event: BleEvent) => void): () => void;
}
