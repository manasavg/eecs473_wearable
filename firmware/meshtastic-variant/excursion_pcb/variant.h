// Excursion wearable PCB: ESP32-S3 + Seeed Wio-SX1262 + u-blox SAM-M10Q + DRV2605 + SK6812MINI.
// Pins come from the team's PCB pinout. Lines marked CHECK need the schematic before flashing.
// Copy this folder to variants/esp32s3/excursion_pcb in a meshtastic/firmware checkout.
// See ../README.md.

// ---------- Buttons ----------
// BOOT button. Meshtastic's user button (screen pages, double press sends position, and so on).
#define BUTTON_PIN 0
#define BUTTON_NEED_PULLUP // CHECK: remove if the PCB has its own pull-up on GPIO0.
// GPIO4: the OK / emergency button. Not defined here: the app's Board setup points the
// Detection Sensor module at it (OK button GPIO 4).
// GPIO5: spare button. Unused by this firmware.
// GPIO3: power button. CHECK: if it drives a soft-power latch that the ESP32 must hold on,
// that needs a power-hold pin here; see the README. GPIO3 is also an ESP32-S3 strapping pin.

// ---------- LoRa: Seeed Wio-SX1262 ----------
#define USE_SX1262
#define LORA_SCK 12
#define LORA_MISO 13
#define LORA_MOSI 11
#define LORA_CS 9
#define LORA_RESET 7
#define LORA_DIO1 15

#define SX126X_CS LORA_CS
#define SX126X_DIO1 LORA_DIO1
#define SX126X_BUSY 14
#define SX126X_RESET LORA_RESET
// Same as Meshtastic's Seeed XIAO ESP32-S3 + Wio-SX1262 variant: DIO2 drives the antenna
// switch, the module's RF_SW pin is the receive enable, and DIO3 powers the 1.8 V TCXO.
#define SX126X_DIO2_AS_RF_SWITCH
#define SX126X_RXEN 6 // RF_SW
#define SX126X_TXEN RADIOLIB_NC
#define SX126X_DIO3_TCXO_VOLTAGE 1.8

// ---------- GPS: u-blox SAM-M10Q ----------
// Meshtastic names these from the GPS side:
#define HAS_GPS 1
#define GPS_RX_PIN 17 // bits going TOWARDS the GPS: the module's RXD (GPS_RXD net)
#define GPS_TX_PIN 18 // bits going TOWARDS the CPU: the module's TXD (GPS_TXD net)
#define GPS_BAUDRATE 38400 // CHECK: the M10's factory rate. Meshtastic also probes other rates.
#define GPS_THREAD_INTERVAL 50

// ---------- I2C: DRV2605 haptic driver ----------
#define I2C_SDA 1
#define I2C_SCL 8
#define HAS_DRV2605 1
#define PIN_DRV_EN 2 // Meshtastic drives this HIGH before starting the DRV2605.

// ---------- SK6812MINI RGB LED ----------
// Lights with the External Notification module, for example when a CHECK IN arrives.
// GRB order at 800 kHz is Meshtastic's default, which suits the SK6812MINI.
#define NEOPIXEL_STATUS_NOTIFICATION_PIN 38
#define NEOPIXEL_STATUS_NOTIFICATION_COLOR 0x0000FF // blue; change to taste

// ---------- Battery ----------
// CHECK: no battery sense pin in the pinout. With none, the app shows no battery level, but
// the battery report still goes out every 60 s as the heartbeat. If the PCB has a divider
// to an ADC1 pin, define BATTERY_PIN, ADC_CHANNEL and ADC_MULTIPLIER (see heltec_v4).
#define BATTERY_PIN -1
