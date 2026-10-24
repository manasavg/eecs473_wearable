# Excursion

Leader phone app. LoRa check-in, and the distance between a GPS on the leader and a GPS on the follower.

- **Leader** is `firmware/leader_device/leader_device.ino`. The phone connects to it over Bluetooth (`Leader_Device_LoRa`). Check in writes a packet whose first byte is 1. The board sends LoRa `CHECK IN`. When the follower sends LoRa `OK`, the leader notifies the phone and the screen shows They're OK.
- **Follower** is `firmware/follower_device/follower_device.ino`. It has no Bluetooth. It reads its own NEO-6M and sends LoRa `POS 42.331427 -83.045754` about every 3 seconds. The OK button sends `OK`.
- **Distance** is calculated on the leader from the two fixes and shown on the phone. Each NEO-6M TX goes to that board's GPIO 47, GND to GND, VCC to 5V. Do not use GPIO 16 or 17. GPIO 17 is the OLED data line. Both antennas need a view of the sky. Compile both sketches as the ESP32 Heltec board.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4317.

On the iPhone project that is already open: `git pull`, then `npm run cap:sync`, then Run in Xcode.

## Flash

1. Leader: `firmware/leader_device/leader_device.ino`
2. Follower: `firmware/follower_device/follower_device.ino`

```bash
npm test
```
