# Radios

Every Heltec board runs stock Meshtastic firmware from https://flasher.meshtastic.org/. Every board needs the same region and channel. The phone talks only to the board it is connected to, which makes that board the leader. Every other board is a follower. To swap the leader, disconnect and tap a different board.

The app works with any number of boards: one leader and one follower is the minimum, and the planned design is one leader and four followers. Nothing in the app is tied to a board count.

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

Use a private channel with its own key. On a shared or default channel, any stranger's board within 2 hops shows up as a follower.

## Lost contact

The app records when the leader last heard anything from each follower. A follower silent for longer than the lost-contact limit is flagged on its card and in the alert banner, and the phone sends a notification. Its distance is then shown as a last known value. The limit is 120 s by default, adjustable from 30 to 3600 s, and saved on the phone.

A board that the radio's database lists but never timed counts its silence from when the phone connected.
## GPS

The Meshtastic firmware reads the GPS. Wire the NEO-6M to the Heltec V4 GPS port: GPIO 38 toward the GPS module, GPIO 39 toward the board, 9600 baud, VCC to 5V, GND to GND. The antennas need a view of the sky.

Positions arrive as `Position` packets and in the node database. `latitude_i` and `longitude_i` are degrees × 10⁷. A missing value, `0, 0`, or a value outside ±90 / ±180 counts as No fix.

## Range

The phone computes the distance and direction from the leader's fix to each follower. The range limit lives only on the phone: 40 m by default, adjustable from 1 to 2000 m, and saved on the phone. The radio is not told the limit. A follower beyond the limit is marked out of range, and the phone sends a local notification.

When either the leader or a follower reports no fix, that follower's distance shows No fix and it is not counted as out of range.

The red LED on a far board is not part of stock Meshtastic, so it does not light.

## Check-in

Each follower card has its own Check in button. Check in all sends one to every follower. Each is a direct Meshtastic text `CHECK IN` with an acknowledgement requested, and each card tracks its own answer.

| Card shows | Meaning |
| --- | --- |
| Sending | The phone is writing it to the leader |
| Waiting | The leader queued it, with this packet id |
| OK | That follower's own radio acknowledged this packet id, or it replied `OK` or `OK ...` |
| No answer | The radio gave up retrying, or 120 s passed with no answer |
| Not delivered | The radio refused it, for example no route or over the airtime limit |

An acknowledgement from the leader itself does not count. That only means another radio repeated the message. An `OK` text counts only while that board has a check-in open. A real answer that arrives after No answer still turns the card OK.

The phone sends a notification when a check-in ends as No answer or Not delivered.

An OK means the follower's radio received the message. It does not mean the person saw it. The stock firmware has no button to confirm.

## Board settings

Set these in the Meshtastic app on every board.

| Setting | Why |
| --- | --- |
| Private channel, same on every board | Keeps strangers' boards out of the follower list |
| Position broadcast interval, shorter than the lost-contact limit | Otherwise a healthy board is flagged between reports. The default is minutes. |
| Smart position: off, or minimum distance well below the range limit | Otherwise a board may not report until it moves farther than the limit |
| Channel position precision: full | Reduced precision rounds positions to hundreds of meters or more |

## Phone in the background

The iPhone app declares Bluetooth background use, so iOS keeps the link to the leader while the phone is locked. iOS may still pause the app's code in the background, so alerts there are not guaranteed. Test this on the phone before relying on it.

## LoRa

Meshtastic sets the LoRa radio from the region and modem preset chosen on each board. The app does not set it.

## Previous firmware

`firmware/excursion_device/excursion_device.ino` was an earlier custom sketch. It used `Excursion_XX` Bluetooth names, its own service, and raw LoRa messages (`FIND`, `HERE`, `PING`, `OK`) at 915 MHz. The app no longer speaks that protocol. Flashing Meshtastic replaces the sketch on the chip.
