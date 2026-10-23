# Excursion

Leader phone app. LoRa check-in and a NEO-6M GPS on the Heltec:

- **LoRa** is `firmware/leader_device/leader_device.ino` on the Heltec. The phone connects to it over Bluetooth (`Leader_Device_LoRa`). Check in writes a packet whose first byte is 1. The board sends LoRa `CHECK IN`. When a follower sends LoRa `OK`, the leader notifies the phone and the screen shows They're OK.
- **GPS** is a NEO-6M wired to that same Heltec. Module TX goes to GPIO 47, GND to GND, VCC to 5V. Do not use GPIO 16 or 17 from a generic ESP32 GPS example. GPIO 17 is the OLED data line. The board reads NMEA at 9600 and notifies latitude and longitude. The antenna needs a view of the sky. Compile the Heltec sketch as the ESP32.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4317.

On the iPhone project that is already open: `git pull`, then `npm run cap:sync`, then Run in Xcode.

## Flash

Leader: `firmware/leader_device/leader_device.ino`

```bash
npm test
```
