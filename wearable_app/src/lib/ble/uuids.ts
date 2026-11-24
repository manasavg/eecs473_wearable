/**
 * Meshtastic Phone API over BLE. The Heltec runs Meshtastic firmware.
 * The phone writes ToRadio, reads FromRadio, and subscribes to FromNum.
 *
 *   Service    6ba1b218-15a8-461f-9fa8-5dcae273eafd
 *   ToRadio    f75c76d2-129e-4dad-a1dd-7866124401e7  write
 *   FromRadio  2c55e69e-4993-11ed-b878-0242ac120002  read
 *   FromNum    ed9da18c-a800-4f66-a670-aa7547e34453  notify
 */

export const BLE_NAME_PREFIX = "Meshtastic";

/** Mesh service advertised by the Meshtastic firmware. */
export const LIVE_SERVICE_UUID = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";

/** ToRadio. PROPERTY_WRITE. One ToRadio protobuf per write. */
export const LIVE_RX_UUID = "f75c76d2-129e-4dad-a1dd-7866124401e7";

/** FromNum. PROPERTY_NOTIFY. A 4-byte counter. The payload is read from FromRadio. */
export const LIVE_TX_UUID = "ed9da18c-a800-4f66-a670-aa7547e34453";

/** FromRadio. PROPERTY_READ. One FromRadio protobuf per read. Empty means the queue is drained. */
export const FROM_RADIO_UUID = "2c55e69e-4993-11ed-b878-0242ac120002";
