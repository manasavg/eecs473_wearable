# Excursion

Leader phone app for three identical Heltec boards. LoRa check-in, distance and direction to each follower, and an out-of-range light plus phone notification.

All three boards run `firmware/excursion_device/excursion_device.ino`. Each one advertises as `Excursion_` plus the last byte of its Bluetooth MAC, for example `Excursion_A3`. The phone lists those names. The board you tap becomes the leader and is the only one that uses the app. The other two stay followers. Disconnect and tap a different board to swap the role.

The leader asks each follower by id (`PING 163`, `PING 163 FAR`, `PING 163 NEAR`) so the two followers do not transmit at the same time. A follower answers `POS 163 42.331427 -83.045754`. `FAR` turns that follower light on. `NEAR` turns it off. The OK button sends `OK 163`.

Each NEO-6M TX goes to that board's GPIO 47, GND to GND, VCC to 5V. Do not use GPIO 16 or 17. GPIO 17 is the OLED data line. The antennas need a view of the sky. The OLED is only for check-in. Compile the sketch as the ESP32 Heltec board.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4317.

On the iPhone project: `git pull`, then `npm install`, then `npm run cap:sync`, then Run in Xcode. In the app, tap Find devices and choose the board that should be the leader.

## Flash

Flash `firmware/excursion_device/excursion_device.ino` onto all three Heltecs. The old `leader_device` and `follower_device` sketches are retired and will not compile.

The serial monitor is 115200. At boot each board prints `NODE Excursion_XX` and its MAC so you can match the list in the app. GPS is 9600 on Serial2, not the USB monitor.

```bash
npm test
```
