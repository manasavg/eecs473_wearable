import type { FollowerInfo, LabSample, Status } from "./types";
import type { AppCommand } from "./types";
import type { BoardPlan, BoardSettings } from "../meshtastic/setup";

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
  /** The connected board's own channel, position, and OK button settings. */
  | { type: "board-settings"; settings: BoardSettings }
  /** The node number of the board the phone is connected to. */
  | { type: "my-node"; id: number }
  /** A board heard for the first time, before its position or name. */
  | { type: "node-seen"; id: number; name: string; at: number | null }
  /** Any packet from a board the leader is tracking. */
  | { type: "heard"; id: number; at: number }
  /** A CHECK IN for this board reached the leader's send queue. */
  | { type: "checkin-sent"; id: number; packetId: number }
  /** The board itself acknowledged that CHECK IN. */
  | { type: "checkin-ack"; id: number; packetId: number }
  /** The radio gave up on that CHECK IN. */
  | { type: "checkin-failed"; id: number; packetId: number; noAnswer: boolean; reason: string }
  | {
      type: "live";
      counter: number | null;
      text: string | null;
      hex: string;
      gps?: { fix: boolean; lat: number | null; lon: number | null; at?: number | null } | null;
      followerGps?: {
        id?: number;
        fix: boolean;
        lat: number | null;
        lon: number | null;
        name?: string | null;
        /** When the leader last heard this board. Null when the radio has no clock. */
        heardAt?: number | null;
        /** When this position was taken. Left out when the event has no position. */
        positionAt?: number | null;
      } | null;
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
  /** Write the team settings to the connected board. Meshtastic links only. */
  setUpBoard?(plan: BoardPlan): Promise<void>;
  subscribe(listener: (event: BleEvent) => void): () => void;
}
