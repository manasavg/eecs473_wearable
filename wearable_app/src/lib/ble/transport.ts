/** One Heltec the phone can choose. Connecting makes that board the leader. */
export interface BlePeer {
  deviceId: string;
  name: string;
}

export type BleEvent =
  | { type: "connected"; deviceName: string }
  | { type: "disconnected"; unexpected: boolean }
  | { type: "reconnecting" }
  | { type: "error"; message: string }
  /** A board's battery report. Percent above 100 means it runs on external power. */
  | { type: "battery"; id: number; percent: number | null; voltage: number | null }
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
      text?: string;
      gps?: { fix: boolean; lat: number | null; lon: number | null; at?: number | null } | null;
      followerGps?: {
        id: number;
        fix: boolean;
        lat: number | null;
        lon: number | null;
        name?: string | null;
        /** When the leader last heard this board. Null when the radio has no clock. */
        heardAt?: number | null;
        /** When this position was taken. Left out when the event has no position. */
        positionAt?: number | null;
      } | null;
      /** Sender of an incoming Meshtastic text message. */
      fromId?: number;
      /** The leader dropped this follower after it stopped answering. */
      followerGoneId?: number | null;
    };

export interface BleTransport {
  connect(remembered?: boolean, peer?: BlePeer): Promise<void>;
  /** Collect Excursion boards until stopScan. The iPhone list uses this. */
  scan?(onPeer: (peer: BlePeer) => void): Promise<void>;
  stopScan?(): Promise<void>;
  disconnect(): Promise<void>;
  sendCheckIn(targetId: number): Promise<void>;
  subscribe(listener: (event: BleEvent) => void): () => void;
}
