# Excursion

Leader phone app for three identical Heltec boards. LoRa check-in, distance and direction to each follower, and an out-of-range light plus phone notification.

All three Heltecs run Meshtastic firmware, flashed from https://flasher.meshtastic.org/ for the matching V4 or V4-R8 board. Use the same region and channel on every board. The phone lists nodes whose name starts with `Meshtastic`. The board you tap is the leader: the app reads that node's database for the other two. Disconnect and tap a different board to swap.

Distance is computed on the phone from the latitudes and longitudes Meshtastic reports. Check-in sends the text `CHECK IN`. A reply text `OK` marks the group OK. The red LED on a far board is not part of stock Meshtastic.

Each NEO-6M TX goes to the GPIO configured as that node's GPS RX, GND to GND, VCC to 5V. Set the GPS baud to 9600 in the node position settings. The antennas need a view of the sky.

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
