import type { FollowerInfo, LabSample, Status } from "./types";
import type { AppCommand } from "./types";

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
      distanceM?: number | null;
    };

export interface BleTransport {
  connect(remembered?: boolean): Promise<void>;
  disconnect(): Promise<void>;
  writeCommand(command: AppCommand): Promise<void>;
  subscribe(listener: (event: BleEvent) => void): () => void;
}
