# Radios

The phone talks only to the Heltec, over BLE. The NEO-6M has no radio of its own. Its TX pin is wired to the Heltec.

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
