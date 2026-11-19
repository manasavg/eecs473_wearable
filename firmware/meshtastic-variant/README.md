# Meshtastic firmware for the Excursion PCB

The app talks to stock Meshtastic. Meshtastic only knows the boards it has a variant for, so the custom PCB needs one: a pin map (`variant.h`) and a build entry (`platformio.ini`). They are in `excursion_pcb/`.

| Part | Pins | How Meshtastic uses it |
| --- | --- | --- |
| Wio-SX1262 | SCK 12, MISO 13, MOSI 11, NSS 9, NRST 7, DIO1 15, BUSY 14, RF_SW 6 | LoRa radio. DIO2 drives the antenna switch, RF_SW is the receive enable, DIO3 powers the 1.8 V TCXO, as on Seeed's XIAO ESP32-S3 kit with the same module |
| SAM-M10Q | GPS_RXD 17, GPS_TXD 18 | GPS. Meshtastic's `GPS_RX_PIN` is the pin towards the GPS, `GPS_TX_PIN` the pin towards the CPU |
| DRV2605 | SDA 1, SCL 8, EN 2 | Vibration through the External Notification module. Meshtastic sets EN high at start |
| SK6812MINI | DIN 38 | Notification light through the External Notification module |
| BOOT button | 0 | Flashing only: hold while plugging in USB |
| OK / emergency button | 4 | Detection Sensor. The app's Board setup sets it: hardware Excursion PCB, OK button GPIO 4 |
| Spare button | 5 | Unused |
| Power button | 3 | Meshtastic's user button: hold to deep sleep, press to wake |
| Battery sense | 10 | VBAT through R10/R11, 100k each, so a ×2 multiplier |

## Build and flash

1. Install [PlatformIO](https://platformio.org/install) (the VS Code extension works).
2. Get the Meshtastic firmware source, at the release you want to run:

   ```bash
   git clone --recursive https://github.com/meshtastic/firmware.git
   ```

3. Copy the variant in:

   ```bash
   cp -r firmware/meshtastic-variant/excursion_pcb meshtastic-firmware/variants/esp32s3/
   ```

   (Run it from this repository, with `meshtastic-firmware` being where you cloned Meshtastic.)
4. Plug the PCB in over USB. If it does not show up as a serial port, hold BOOT, press reset or power, then release BOOT.
5. Build and flash:

   ```bash
   cd meshtastic-firmware && pio run -e excursion-pcb -t upload
   ```

6. Watch the log to check each part came up:

   ```bash
   pio device monitor -b 115200
   ```

   Look for the SX1262 starting, the GPS being detected, `DRV2605` and `Use WS2812 on GPIO 38`.

7. In the Excursion app: connect, open Settings → Board setup, set Hardware to Excursion PCB, set the region, and set up the board. That sets the channel, position reports, battery heartbeat, the OK button on GPIO 4, and vibration plus light when a CHECK IN arrives.

The web flasher at flasher.meshtastic.org only offers boards Meshtastic ships, so the PCB is flashed from PlatformIO.

## Questions to answer from the schematic

Each is marked `CHECK` in `variant.h`.

1. **ESP32-S3 module.** Answered: WROOM-1-N8R8 (8 MB flash, 8 MB octal PSRAM). `platformio.ini` is set for it.
2. **RF_SW.** Answered: the Wio-SX1262's receive enable, as on Seeed's kit.
3. **Power button on GPIO3.** Answered: deep sleep. It is `BUTTON_PIN 3`. Still to check: does GPIO3 have an external pull-up? With none, the firmware uses the internal one; an external 10k to 3V3 is safer for waking from deep sleep.
4. **Battery sense.** Answered from the schematic: R10 and R11, 100k each, from VBAT to GND with GPIO10 between them. `ADC_MULTIPLIER` is 2.0. The divider is always on, about 20 uA.
5. **Pull-ups.** Do the buttons on 0, 4 and 5 have external pull-ups? The OK button uses the ESP32's internal pull-up either way.
6. **GPS baud.** The SAM-M10Q's factory rate is usually 38400. Meshtastic probes other rates if that fails.
7. **USB.** Is the ESP32-S3's native USB (GPIO 19 and 20) wired to the connector? That is how it is flashed and how the log is read.

## Deep sleep

Hold the power button (GPIO3) for several seconds and Meshtastic shuts down. On this board that is deep sleep: the ESP32-S3 stops and only the button can wake it. A press wakes it, and the board restarts and reconnects to the mesh. Meshtastic also goes to deep sleep on its own when the battery gets critically low.

The ESP32-S3 itself draws microamps in deep sleep, but the other parts on 3V3 stay powered:

| Part | In deep sleep | What to do |
| --- | --- | --- |
| SAM-M10Q GPS | Keeps running, roughly 10 to 30 mA, unless sent to backup mode. There is no power switch for it on the schematic. | Measure. If Meshtastic does not put it to sleep, add a load switch on its VCC, or drive its backup mode from firmware. |
| SK6812MINI LED | About 1 mA even when dark | Accept it, or switch its power |
| Wio-SX1262 | Meshtastic puts the radio to sleep first, microamps | Nothing |
| DRV2605 | EN floats once the ESP32 sleeps | Add a pull-down on EN (GPIO2) so the driver stays off |
| Battery divider | About 20 uA | Nothing |

Measure the battery current in deep sleep on the first board. The GPS is the part most likely to keep draining it.
