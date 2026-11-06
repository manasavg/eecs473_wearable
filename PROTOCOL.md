# Radios

The phone talks only to the board it connected to. That connection makes the board the leader. The other boards are followers. All three run `firmware/excursion_device/excursion_device.ino`.

## Bluetooth

| | |
| --- | --- |
| Name | `Excursion_` plus two hex digits, the last byte of the Bluetooth MAC |
| Service | `20b723dd-215e-4424-bd75-746a902408bb` |
| TX notify | `209989cd-1fc7-4eb1-979e-690ba55053da` |
| RX write | `0be48bf3-86c4-4d13-8e2c-2ac0a569817c` |

The service UUID is not advertised. The phone scans for the name prefix, shows each board, and connects to the one you tap. Disconnecting returns that board to follower.

Check-in write is 4 bytes: `1`, command `0`, target id, `0`. The leader sends LoRa `CHECK IN`.

Range write is 5 bytes: `1`, command `1`, target id, uint16 meters little-endian. `500` m is `01 01 ff f4 01`. The leader stores that limit. It does not treat this write as a check-in.

A follower LoRa message `OK 163` is notified as the three bytes `O`, `K`, id. `OK` with no id is still the two bytes `OK`. The phone names the board when the id is present.

TX also sends one counter byte every 3 seconds while the phone is connected. That byte is the link heartbeat.

## GPS

NEO-6M TX to Heltec GPIO 47, GND to GND, VCC to 5V. Serial2 is 9600 8N1. The leader notifies 10 bytes for its own fix:

| Offset | Meaning |
| --- | --- |
| 0 | `G` (`0x47`) |
| 1 | `1` when the fix is valid, `0` when it is not |
| 2–5 | latitude, int32 degrees × 10⁷, little-endian |
| 6–9 | longitude, int32 degrees × 10⁷, little-endian |

`42.5, -83.25` with a lock is `47 01 40 fc 54 19 e0 0e 61 ce`. A later counter byte does not clear the last fix. A packet with fix `0` clears it and the phone shows No fix.

Each follower fix is 11 bytes:

| Offset | Meaning |
| --- | --- |
| 0 | `F` (`0x46`) |
| 1 | follower id, the same byte as in `Excursion_XX` |
| 2 | `1` when the fix is valid, `0` when it is not |
| 3–6 | latitude, int32 degrees × 10⁷, little-endian |
| 7–10 | longitude, int32 degrees × 10⁷, little-endian |

The leader drops a follower that has not answered for 15 seconds and notifies `X` plus that id. The phone removes that card.

## LoRa

Same radio on every board: 915.0 MHz, bandwidth 125, spreading factor 9, coding rate 5, sync word `0x12`. A board cannot hear while it is transmitting.

The leader sends `FIND` and then listens. Each follower answers `HERE <id>` after a short stagger so the two replies do not overlap. The leader then polls one id at a time:

```text
PING 163
PING 163 FAR
PING 163 NEAR
```

`FAR` means that follower is past the range limit. `NEAR` means it is inside. A `PING` with no FAR or NEAR leaves that light as it is. Only the addressed follower replies:

```text
POS 163 42.331427 -83.045754
POS 163 NOFIX
```

When both fixes are valid the leader notifies 6 bytes:

| Offset | Meaning |
| --- | --- |
| 0 | `M` (`0x4D`) |
| 1 | follower id |
| 2–5 | centimeters, uint32 little-endian. `0xFFFFFFFF` means no distance |

`12.34 m` for id 163 is `4d a3 d2 04 00 00`. The distance is the haversine between the two points, using an Earth radius of 6,371,000 m.

A 10-byte `F` and a 5-byte `M` are the older single-follower packets. The phone reads those as follower id 0.
