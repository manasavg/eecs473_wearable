# Radios

The phone talks only to the Heltec, over BLE. The DW1000 boards do not use BLE.

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

## UWB

`firmware/uwb/anchor/anchor.ino` and `firmware/uwb/tag/tag.ino`

Channel 2, `MODE_LONGDATA_RANGE_ACCURACY`. The anchor is an Arduino Uno. It prints a filtered average every 2 seconds and writes `DIST 12.34` at 9600 from pin 9 (SoftwareSerial). Uno pin 0/1 stay the USB serial monitor.

Heltec Serial2 RX is GPIO 47, 9600 8N1. Share ground. The Heltec then notifies 3 bytes on TX:

| Offset | Meaning |
| --- | --- |
| 0 | `D` (`0x44`) |
| 1–2 | centimeters, uint16 little-endian |

`12.34 m` is `44 d2 04`. A later counter byte does not clear the last distance.
