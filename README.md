# Excursion

Leader phone app for three identical Heltec boards. LoRa check-in, distance and direction to each follower, and an out-of-range light plus phone notification.

All three Heltecs run Meshtastic firmware, flashed from https://flasher.meshtastic.org/ for the matching V4 or V4-R8 board. Use the same region and channel on every board. The phone lists nodes whose name starts with `Meshtastic`. The board you tap is the leader: the app reads that node's database for the other two. Disconnect and tap a different board to swap.

The phone uses Meshtastic's own client. The Heltec V4 firmware already runs the SX1262 LoRa radio and the GPS port: GPIO 38 toward the GPS module, GPIO 39 toward the board, 9600 baud. Wire the NEO-6M there, with VCC to 5V and GND to GND. The antennas need a view of the sky.

Check-in uses Meshtastic text. A board shows OK when it confirms the message. The red LED on a far board is not part of stock Meshtastic.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4317.

On the iPhone project: `git pull`, then `npm run cap:sync`, then Run in Xcode. That copies the already built app into the Xcode project. It does not compile, and it does not run `xcodebuild`. In the app, tap Find devices and choose the board that should be the leader.

## Firmware

The boards run Meshtastic, not `firmware/excursion_device/excursion_device.ino`. That sketch is the previous radio program. Flashing Meshtastic replaces it on the chip. To put it back, upload that sketch from the Arduino IDE.

```bash
npm test
```
