# Radios

All three Heltec boards run stock Meshtastic firmware from https://flasher.meshtastic.org/. Every board needs the same region and channel. The phone talks only to the board it is connected to, which makes that board the leader. The other boards are followers. To swap the leader, disconnect and tap a different board.

The phone uses Meshtastic's own client (`@meshtastic/core`). `src/lib/meshtastic/link.ts` passes that client's events to the dashboard.

## Bluetooth

This is the Meshtastic Phone API.

| | |
| --- | --- |
| Name | Starts with `Meshtastic` |
| Service | `6ba1b218-15a8-461f-9fa8-5dcae273eafd` |
| ToRadio write | `f75c76d2-129e-4dad-a1dd-7866124401e7` |
| FromRadio read | `2c55e69e-4993-11ed-b878-0242ac120002` |
| FromNum notify | `ed9da18c-a800-4f66-a670-aa7547e34453` |

The phone scans for the name prefix, shows each board, and connects to the one you tap.

Each ToRadio write is one `ToRadio` protobuf. FromNum notifies a 4-byte counter when the radio has something queued. The phone then reads FromRadio repeatedly, one `FromRadio` protobuf per read, until a read comes back empty.

Once connected, the phone sends `want_config`. The radio answers with its own node info and its node database.

## Nodes

`MyNodeInfo` tells the phone which node number belongs to the leader. That node's position is the leader's own GPS fix.

Every other node in the database is shown as a follower card, named by its long name, then its short name, then `Meshtastic` plus the last four hex digits of its node number. A node is left out when it is:

- heard over MQTT,
- ignored on the radio,
- more than 2 hops away, or
- not heard for 6 hours.

## GPS

The Meshtastic firmware reads the GPS. Wire the NEO-6M to the Heltec V4 GPS port: GPIO 38 toward the GPS module, GPIO 39 toward the board, 9600 baud, VCC to 5V, GND to GND. The antennas need a view of the sky.

Positions arrive as `Position` packets and in the node database. `latitude_i` and `longitude_i` are degrees × 10⁷. A missing value, `0, 0`, or a value outside ±90 / ±180 counts as No fix.

## Range

The phone computes the distance and direction from the leader's fix to each follower. The range limit lives only on the phone: 40 m by default, adjustable from 1 to 2000 m. The radio is not told the limit. A follower beyond the limit is marked out of range, and the phone sends a local notification.

The red LED on a far board is not part of stock Meshtastic, so it does not light.

## Check-in

Check-in sends the Meshtastic text `CHECK IN`, with an acknowledgement requested, to each follower the phone knows about. If none are known yet, it broadcasts on the channel.

A follower counts as OK when either:

- its radio acknowledges the message (a routing packet with no error), or
- it replies with text that is `OK` or starts with `OK `.

## LoRa

Meshtastic sets the LoRa radio from the region and modem preset chosen on each board. The app does not set it.

## Previous firmware

`firmware/excursion_device/excursion_device.ino` was an earlier custom sketch. It used `Excursion_XX` Bluetooth names, its own service, and raw LoRa messages (`FIND`, `HERE`, `PING`, `OK`) at 915 MHz. The app no longer speaks that protocol. Flashing Meshtastic replaces the sketch on the chip.
