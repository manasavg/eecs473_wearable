# Radios

The phone talks only to the leader Heltec, over BLE. Each NEO-6M TX pin is wired to its own Heltec. The follower sends its position to the leader over LoRa.

## LoRa leader

`firmware/leader_device/leader_device.ino`

| | |
| --- | --- |
| Name | `Leader_Device_LoRa` (service UUID is not advertised) |
| Service | `20b723dd-215e-4424-bd75-746a902408bb` |
| TX notify | `209989cd-1fc7-4eb1-979e-690ba55053da` |
| RX write | `0be48bf3-86c4-4d13-8e2c-2ac0a569817c` |

Check-in write is 4 bytes, first byte `1`. The sketch sends LoRa `CHECK IN`.

A follower LoRa message `OK` (or `OK` plus an id) is notified back as the two bytes `OK`. The phone shows They're OK only after that notify.

TX also sends one counter byte every 3 seconds. That byte is the link heartbeat.

## GPS

NEO-6M TX to Heltec GPIO 47, GND to GND, VCC to 5V. Serial2 is 9600 8N1. The sketch parses `$GPRMC` / `$GPGGA` (and the `GN` forms) and notifies 10 bytes on TX:

| Offset | Meaning |
| --- | --- |
| 0 | `G` (`0x47`) |
| 1 | `1` when the fix is valid, `0` when it is not |
| 2–5 | latitude, int32 degrees × 10⁷, little-endian |
| 6–9 | longitude, int32 degrees × 10⁷, little-endian |

`42.5, -83.25` with a lock is `47 01 40 fc 54 19 e0 0e 61 ce`. A later counter byte does not clear the last fix. A packet with fix `0` clears it and the phone shows No fix.

## Follower position

`firmware/follower_device/follower_device.ino`

Same radio settings as the leader: 915.0 MHz, bandwidth 125, spreading factor 9, coding rate 5, sync word `0x12`. LoRa cannot receive during a transmit, so the follower does not broadcast on its own. About every 4 seconds the leader sends `PING`, then listens for 1.5 seconds. The follower replies with one of:

```text
POS 42.331427 -83.045754
POS NOFIX
```

The leader stores that fix. If no `POS` arrives for 15 seconds, the follower fix is dropped. When both fixes are valid the leader notifies 5 bytes on TX:

| Offset | Meaning |
| --- | --- |
| 0 | `M` (`0x4D`) |
| 1–4 | centimeters, uint32 little-endian. `0xFFFFFFFF` means no distance |

`12.34 m` is `4d d2 04 00 00`. A later counter byte does not clear the last distance. A no-distance packet clears it and the phone shows No fix. The distance is the haversine between the two points, using an Earth radius of 6,371,000 m.
