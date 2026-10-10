# Excursion

Leader phone app. Two radios, kept separate:

- **LoRa** is `firmware/leader_device/leader_device.ino` on the Heltec. The phone connects to it over Bluetooth (`Leader_Device_LoRa`). Check in writes a packet whose first byte is 1. The board sends LoRa `CHECK IN`. When a follower sends LoRa `OK`, the leader notifies the phone and the screen shows They're OK.
- **UWB** is `firmware/uwb/anchor/anchor.ino` and `firmware/uwb/tag/tag.ino` on the DW1000 boards. They are not the Heltec. The anchor is an Arduino Uno. It sends `DIST 12.34` at 9600 from pin 9. Wire Uno pin 9 to Heltec GPIO 47 RX, and connect the grounds. In the Arduino IDE, compile both UWB sketches as Arduino Uno. Compile the Heltec sketch as the ESP32. The Heltec forwards the meters to the phone.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4317.

On the iPhone project that is already open: `git pull`, then `npm run cap:sync`, then Run in Xcode.

## Flash

1. Anchor: `firmware/uwb/anchor/anchor.ino`
2. Leader: `firmware/leader_device/leader_device.ino`
3. Tag: leave it if it already matches `firmware/uwb/tag/tag.ino`

```bash
npm test
```
