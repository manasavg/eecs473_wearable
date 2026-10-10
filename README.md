# Excursion

Leader phone app. Two radios, kept separate:

- **LoRa** is `firmware/leader_device/leader_device.ino` on the Heltec. The phone connects to it over Bluetooth (`Leader_Device_LoRa`). Check in writes a packet whose first byte is 1. The board sends LoRa `CHECK IN`. When a follower sends LoRa `OK`, the leader notifies the phone and the screen shows They're OK.
- **UWB** is `firmware/uwb/anchor/anchor.ino` and `firmware/uwb/tag/tag.ino` on the DW1000 boards. They are not the Heltec. The anchor sends `DIST 12.34` at 9600. On an ESP32 anchor that pin is GPIO 17. On an Uno or Nano it is pin 9. Wire it to Heltec GPIO 47 RX, and connect the grounds. The Heltec forwards the meters to the phone.

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
