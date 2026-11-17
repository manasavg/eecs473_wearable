#ifndef _VARIANT_WEARABLE_H_
#define _VARIANT_WEARABLE_H_

// Hardware Model
#define HW_VENDOR meshtastic_HardwareModel_PRIVATE_HW

// --- I2C Bus (DRV2605 Haptics) ---
#define I2C_SDA 1
#define I2C_SCL 8
#define HAS_DRV2605 1

// Enable DRV2605 EN pin (GPIO2) via VEXT rail control (Active HIGH)
#define VEXT_ENABLE 2
#define VEXT_ON_VALUE HIGH

// --- LoRa Radio (Wio-SX1262) ---
#define USE_SX1262

#define LORA_SCK 12
#define LORA_MISO 13
#define LORA_MOSI 11
#define LORA_CS 9

#define LORA_RESET 7
#define LORA_DIO1 15
#define LORA_BUSY 14

// SX126x Specifics
#define SX126X_CS LORA_CS
#define SX126X_DIO1 LORA_DIO1
#define SX126X_BUSY LORA_BUSY
#define SX126X_RESET LORA_RESET

// Wio-SX1262 uses DIO3 at 1.8V to power its internal TCXO
#define SX126X_DIO3_TCXO_VOLTAGE 1.8

// External RF_SW routed to GPIO6 (RX Enable)
// Note: If TX power is weak/missing, check your RF switch truth table (DIO2 + RXEN)
#define SX126X_RXEN 6
#define SX126X_DIO2_AS_RF_SWITCH

// --- GPS (u-blox SAM-M10Q) ---
// Note: Verify whether your net names GPS_RXD/GPS_TXD are from the ESP32 or GPS perspective
#define GPS_RX_PIN 18 // Connects to SAM-M10Q TXD
#define GPS_TX_PIN 17 // Connects to SAM-M10Q RXD

// --- Addressable RGB LED (SK6812MINI) ---
#define HAS_NEOPIXEL 1
#define NEOPIXEL_DATA 38
#define NEOPIXEL_COUNT 1
#define NEOPIXEL_TYPE (NEO_GRB + NEO_KHZ800)

// --- Pushbuttons ---
// BOOT PB is hardware-wired to GPIO0 (no define needed)
// Power ON PB (User Button: wake, long-press shutdown, triple-click GPS)
#define BUTTON_PIN 3
#define BUTTON_NEED_PULLUP

// Additional Message / Response Pushbuttons (for Canned Message Module)
#define BUTTON_PIN_ALT 4
#define BUTTON_PIN_TOUCH 5

#endif