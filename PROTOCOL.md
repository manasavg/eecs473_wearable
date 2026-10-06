# Excursion beacon BLE protocol

The phone is the BLE **central**. The leader beacon (ESP32) is the **peripheral**.
No cellular link is required. Classic Bluetooth is not used, because iOS will not
give a third-party app a serial port.

## Flashed sketch

`firmware/leader_device/leader_device.ino` is the firmware already talking to the phone.
The app connects to it. Do not change these to open the link:

| | |
| --- | --- |
| Advertised name | `Leader_Device` |
| Service | `2b30c8ab-64a1-4c5d-a8fc-3089a210b8f1` |
| Characteristic | `017b6e07-c0b7-411a-8c8b-e54cb2fcf2b8` (read, write, notify, indicate) |

`setup()` stores the text `Data successfully transmitted`. While the phone is
connected, `loop()` notifies a little-endian `uint32` every 500 ms and increments it.
The dashboard shows that counter. A 4-byte notification is the counter, not an alert.

Check-ins and the separation line are written to that same characteristic until a
dedicated command characteristic exists. The current `loop()` does not read them.

## Wristband packets (next firmware)

Bytes below are little-endian. Every structured packet starts with a version byte
(`1` today, `PACKET_VERSION` in `src/lib/ble/constants.ts`). Longer packets are
accepted; unknown trailing bytes are ignored. A different version byte is rejected.

The phone already decodes a 9-byte follower or a 3-byte leader packet if it
arrives on the characteristic above. It also subscribes to the UUIDs in the table
if you add those characteristics to the **same** service. They are not on the
flashed sketch.

| Role | UUID |
| --- | --- |
| Service (already flashed) | `2b30c8ab-64a1-4c5d-a8fc-3089a210b8f1` |
| Data (already flashed) | `017b6e07-c0b7-411a-8c8b-e54cb2fcf2b8` |
| Leader status (read, notify) | `47300002-0000-4000-8000-657863757273` |
| Follower status (notify) | `47300003-0000-4000-8000-657863757273` |
| Alert (notify) | `47300004-0000-4000-8000-657863757273` |
| Command (write or write-without-response) | `47300005-0000-4000-8000-657863757273` |

Keep advertising `Leader_Device` and the service UUID already in the sketch.
The Beacon link sheet can override the name prefix on this phone only.

Require LE Secure Connections with bonding so a nearby phone cannot write commands.

## Follower status — 9 bytes, one notification per wristband

Appendix C stores floats on the MCU. On the air the record is integers so it
fits in one notification at the default 20-byte ATT payload.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | version = 1 |
| 1 | uint8 | device id (1, 2, … — never `0xFF`) |
| 2 | uint8 | status: 0 OK, 1 check-in pending, 2 need help, 3 out of range |
| 3 | uint8 | battery percent 0–100, or `0xFF` if unknown |
| 4 | uint16 | distance in centimeters, or `0xFFFF` if UWB has no fix |
| 6 | int16 | angle in centidegrees, or `0x7FFF` if UWB has no fix |
| 8 | uint8 | flags, bit 0 = UWB out of range |

Angle `0` is straight ahead, the top of the phone. Positive is clockwise,
because the beacon is clipped to the back of the phone and faces the same way.
If a bench test shows the BU04 module counting the other direction, set
`ANGLE_SIGN` to `-1` in `src/lib/ble/protocol.ts`.

Known vector (wristband 1, OK, 80% battery, 12.5 m, −30°, in range):

```text
01 01 00 50 E2 04 48 F4 00
```

`E2 04` is 1250 cm. `48 F4` is −3000 centidegrees.

Send the current table when the phone subscribes, then again when a value
changes or on a slow refresh. The radio cycle itself is 2 seconds; the phone
does not need a notification every cycle if nothing changed.

Status priority the demo uses, and the app expects:

1. Need Help, if the 3-second press is latched and they have not pressed OK
2. Check-in pending, if a check-in is waiting on the button
3. Out of range, if 10 UWB pings were missed or the sustained distance filter tripped
4. OK

Ten missed pings drop distance and angle (`0xFFFF` / `0x7FFF`) and set flag bit 0.
A lowered separation line (for example 25 m) can be out of range while distance
and angle are still present. One sample past the line should not alert; the demo
waits 3 cycles. Match that filter in firmware, or change
`SUSTAINED_OVER_THRESHOLD_CYCLES` so the demo stays honest.

## Leader status — 3 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | version = 1 |
| 1 | uint8 | beacon battery percent, or `0xFF` |
| 2 | uint8 | reserved, write 0 |

There is no battery LED on the beacon. This packet is how the leader sees it.
Example, 86%: `01 56 00`.

## Alert — 4 bytes

Edge-triggered. Send it when a wristband enters Need Help or Out of range, in
addition to the follower status notification. The app de-duplicates, so sending
both does not page the leader twice.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | version = 1 |
| 1 | uint8 | device id |
| 2 | uint8 | status (2 need help, or 3 out of range) |
| 3 | uint8 | flags, bit 0 = UWB out of range |

## Command — 4 bytes, phone writes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | uint8 | version = 1 |
| 1 | uint8 | 0 check-in, 1 set threshold |
| 2 | uint8 | target id, or `0xFF` for the whole group |
| 3 | uint8 | threshold in meters (5–40). Zero on a check-in. |

Check-in for wristband 2: `01 00 02 00`.
Separation line 25 m for everyone: `01 01 FF 19`.

Prefer write-without-response so a check-in does not stall a ranging window.
The phone uses that property when the characteristic offers it.

The app sends the current separation line once, right after connect.

## What the phone will not do

It does not range, and it does not decide that someone is lost once a real
beacon is connected. It displays the status byte and the alert packet.
The demo trail in `src/lib/ble/mock-transport.ts` is the only place those
rules run on the phone, and only until firmware replaces it.
