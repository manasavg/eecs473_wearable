/** First byte of a check-in write. The LoRa sketch sends CHECK IN when this is 1. */
export const PACKET_VERSION = 1;

/** Check-in target for the whole group. */
export const BROADCAST_ID = 0xff;

export const DEFAULT_THRESHOLD_M = 40;
export const THRESHOLD_MIN_M = 5;
export const THRESHOLD_MAX_M = 40;
