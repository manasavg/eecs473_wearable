// Heltec V4: LoRa and BLE only.
// UWB ranging runs on the separate DW1000 boards (firmware/uwb).
// This sketch reads "DIST 12.34" from the anchor UART and notifies the phone.

//BLE includes
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

//LoRa includes
#include <RadioLib.h>
#include <U8x8lib.h>
#include <Wire.h>

//LoRa preliminaries
//---------------------------------------------------------------------------------------------------
//---------------------------------------------------------------------------------------------------
// Heltec V4 Pin Mapping
#define OLED_SDA    17
#define OLED_SCL    18
#define OLED_RST    21
#define VEXT_CTRL   36  // Pull LOW for power rail

#define LORA_NSS    8
#define LORA_DIO1   14
#define LORA_RST    12
#define LORA_BUSY   13

#define FEM_EN      2
#define FEM_PA      5
#define BOARD_LED   38  // V4 Onboard RGB LED (GPIO38)

#define FEM_POWER   7

// External Button Pins (Safe GPIOs)
#define BTN_CHECKIN_PIN 4   // Button 1: Sends "CHECK IN"
#define BTN_OK_PIN      6   // Button 2: Sends "OK"

// UWB anchor is an Arduino Uno. Its pin 9 TX wires to UWB_RX_PIN. GND to GND. 9600 baud.
// UWB_TX_PIN is unused. Do not wire it. IRQ on the DW1000 stays off this board
// because GPIO 2 is already FEM_EN.
#define UWB_RX_PIN      47
#define UWB_TX_PIN      48

// Debounce timing
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 250; // ms

bool check = false;
int i = 0;
String uwbLine;
unsigned long lastNotifyMs = 0;
const unsigned long NOTIFY_MS = 3000;

// Screen Initialization (U8x8 Non-blocking driver)
U8X8_SSD1306_128X64_NONAME_SW_I2C u8x8(OLED_SCL, OLED_SDA, OLED_RST);
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);

void printScreen(String line1, String line2, String line3 = "") {
  u8x8.clearDisplay();
  u8x8.setCursor(0, 0);
  u8x8.print(line1);
  u8x8.setCursor(0, 2);
  u8x8.print(line2);
  if (line3.length() > 0) {
    u8x8.setCursor(0, 4);
    u8x8.print(line3);
  }
}

// Helper function to transmit LoRa packet
void sendLoRaMessage(String outgoingMsg) {
  rgbLedWrite(BOARD_LED, 0, 0, 255); // Blue flash

  Serial.print("\n[Transmitting]: ");
  Serial.println(outgoingMsg);

  printScreen("TRANSMITTING...", outgoingMsg);

  digitalWrite(FEM_PA, HIGH);
  int txState = radio.transmit(outgoingMsg);
  digitalWrite(FEM_PA, LOW);

  if (txState == RADIOLIB_ERR_NONE) {
    Serial.println(" -> TX Success!");
    printScreen("TX SUCCESS!", "Sent:", outgoingMsg);
  } else {
    Serial.print(" -> TX Failed, code: ");
    Serial.println(txState);
    printScreen("TX FAILED!", "Code: " + String(txState));
  }

  rgbLedWrite(BOARD_LED, 0, 0, 0); // Turn off LED
  radio.startReceive();
}


//BLE preliminaries
//---------------------------------------------------------------------------------------------------
//---------------------------------------------------------------------------------------------------
BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic;
bool deviceConnected = false;
bool oldDeviceConnected = false;
uint8_t txValue = 0;
uint8_t rxValue = 0;

// See the following for generating UUIDs:
// https://www.uuidgenerator.net/

#define SERVICE_UUID           "20b723dd-215e-4424-bd75-746a902408bb"  // UART service UUID
#define CHARACTERISTIC_UUID_RX "0be48bf3-86c4-4d13-8e2c-2ac0a569817c"
#define CHARACTERISTIC_UUID_TX "209989cd-1fc7-4eb1-979e-690ba55053da"

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) {
    deviceConnected = true;
    Serial.println("Device connected");
  };

  void onDisconnect(BLEServer *pServer) {
    deviceConnected = false;
    Serial.println("Device disconnected");
  }
};

class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue();

    if (rxValue.length() > 0) {
      Serial.println("*********");
      Serial.print("Received Value: ");
      for (int i = 0; i < rxValue.length(); i++) {
        Serial.print((uint8_t)rxValue[i]);
      }
      if ((uint8_t)rxValue[i] == 1){
        check = true;
      }
      Serial.println();
      Serial.println("*********");
    }
  }
};

// 'D' + uint16 centimeters, little-endian, on the TX characteristic.
void notifyDistanceMeters(float meters) {
  if (!deviceConnected || pTxCharacteristic == NULL) return;
  if (meters < 0.0f || meters > 100.0f) return;
  uint16_t cm = (uint16_t)(meters * 100.0f + 0.5f);
  uint8_t pkt[3];
  pkt[0] = 'D';
  pkt[1] = (uint8_t)(cm & 0xFF);
  pkt[2] = (uint8_t)((cm >> 8) & 0xFF);
  pTxCharacteristic->setValue(pkt, 3);
  pTxCharacteristic->notify();
  Serial.print("Phone notified distance: ");
  Serial.print(meters, 2);
  Serial.println(" m");
  printScreen("UWB DISTANCE", String(meters, 2) + " m");
}

bool distanceFromText(String msg, float *meters) {
  msg.trim();
  int start = -1;
  if (msg.startsWith("DIST ") || msg.startsWith("dist ")) {
    start = 5;
  } else {
    int at = msg.indexOf("avg=");
    if (at < 0) at = msg.indexOf("AVG=");
    if (at >= 0) start = at + 4;
  }
  if (start < 0 || start >= (int)msg.length()) return false;
  bool digit = false;
  for (int k = start; k < (int)msg.length(); k++) {
    char c = msg[k];
    if (c >= '0' && c <= '9') {
      digit = true;
      break;
    }
    if (c != ' ' && c != '.' && c != '-' && c != '+') break;
  }
  if (!digit) return false;
  *meters = msg.substring(start).toFloat();
  return true;
}

void handleDistanceText(String msg) {
  float meters = 0;
  if (!distanceFromText(msg, &meters)) return;
  notifyDistanceMeters(meters);
}

void pollUwbUart() {
  while (Serial2.available() > 0) {
    char c = (char)Serial2.read();
    if (c == '\n' || c == '\r') {
      if (uwbLine.length() > 0) {
        Serial.print("UWB line: ");
        Serial.println(uwbLine);
        handleDistanceText(uwbLine);
        uwbLine = "";
      }
    } else if (uwbLine.length() < 80) {
      uwbLine += c;
    } else {
      uwbLine = "";
    }
  }
}

void setup() {

  //LoRa setup
  //---------------------------------------------------------------------------------------------------
  //---------------------------------------------------------------------------------------------------
  // 1. ENABLE VEXT POWER
  pinMode(VEXT_CTRL, OUTPUT);
  digitalWrite(VEXT_CTRL, LOW);
  delay(100);

  // 2. OLED RESET
  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW);
  delay(20);
  digitalWrite(OLED_RST, HIGH);
  delay(20);

  // 3. INITIALIZE SCREEN
  u8x8.begin();
  u8x8.setPowerSave(0);
  u8x8.setFlipMode(1);
  u8x8.setFont(u8x8_font_chroma48medium8_r);
  printScreen("Heltec V4 LoRa", "Booting...", "Initializing RF");

  // 4. SERIAL
  Serial.begin(115200);
  delay(300);
  Serial.println("HELTEC UP");
  Serial2.begin(9600, SERIAL_8N1, UWB_RX_PIN, UWB_TX_PIN);
  Serial.println("UWB distance UART is Serial2 RX GPIO 47 at 9600.");
  Serial.println("--- HELTEC V4 LORA NODE STARTUP & BLE! ---");

  //BLE setup
  //---------------------------------------------------------------------------------------------------
  //---------------------------------------------------------------------------------------------------
  // Create the BLE Device
  BLEDevice::init("Leader_Device_LoRa");

  // Create the BLE Server
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // Create the BLE Service
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Create a BLE Characteristic
  pTxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);

  // Descriptor 2902 is not required when using NimBLE as it is automatically added based on the characteristic properties
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_RX, BLECharacteristic::PROPERTY_WRITE);

  pRxCharacteristic->setCallbacks(new MyCallbacks());

  // Start the service
  pService->start();

  // Start advertising
  pServer->getAdvertising()->start();
  Serial.println("Waiting a client connection to notify...");

  // 5. FEM CONFIG
  pinMode(FEM_POWER, OUTPUT);
  digitalWrite(FEM_POWER, HIGH);
  delay(10);
  pinMode(FEM_EN, OUTPUT);
  digitalWrite(FEM_EN, HIGH);
  pinMode(FEM_PA, OUTPUT);
  digitalWrite(FEM_PA, LOW);
  delay(10);

  //LoRa setup continued
  //---------------------------------------------------------------------------------------------------
  //---------------------------------------------------------------------------------------------------
  // 6. BUTTON CONFIGURATION
  pinMode(BTN_CHECKIN_PIN, INPUT_PULLUP);
  pinMode(BTN_OK_PIN, INPUT_PULLUP);

  // 7. RADIO INIT
  int state = radio.begin(915.0, 125.0, 9, 5, 0x12, 10, 8, 1.8);

  if (state == RADIOLIB_ERR_NONE) {
    Serial.println("SX1262 Init Success!");
    printScreen("Heltec V4 Node", "Ready to Send", "Press a Button");
  } else {
    Serial.print("SX1262 Init Failed, Code: ");
    Serial.println(state);
    printScreen("ERROR!", "Radio Failed", "Code: " + String(state));
    while (true);
  }

  radio.setDio2AsRfSwitch(true);
  radio.startReceive();
}

void loop() {
  pollUwbUart();

  // 1. RECEIVE INCOMING LORA MESSAGES
  if (digitalRead(LORA_DIO1) == HIGH) {
    String str;
    int radioState = radio.readData(str);

    if (radioState == RADIOLIB_ERR_NONE && str.length() > 0) {
      int rssi = radio.getRSSI();

      Serial.print("\n[Received]: \"");
      Serial.print(str);
      Serial.print("\" | RSSI: ");
      Serial.print(rssi);
      Serial.println(" dBm");

      String msg = str;
      msg.trim();
      String upper = msg;
      upper.toUpperCase();
      if (deviceConnected && pTxCharacteristic != NULL && (upper == "OK" || upper.startsWith("OK "))) {
        uint8_t okBytes[2] = { 'O', 'K' };
        pTxCharacteristic->setValue(okBytes, 2);
        pTxCharacteristic->notify();
        Serial.println("Phone notified: OK");
      }
      handleDistanceText(msg);

      rgbLedWrite(BOARD_LED, 0, 255, 0); // Green flash
      printScreen("RECEIVED PACKET", str, "RSSI: " + String(rssi) + " dBm");
      delay(150);
      rgbLedWrite(BOARD_LED, 0, 0, 0);
    }

    radio.startReceive();
  }

  // 2. CHECK BUTTON PRESSES
  if ((millis() - lastDebounceTime) > debounceDelay) {
    // Check "CHECK IN" Button (GPIO 7)
    if (check) {
      lastDebounceTime = millis();
      sendLoRaMessage("CHECK IN");
      check = false;
    }
  }

  // 3. SERIAL TRANSMIT
  if (Serial.available() > 0) {
    String outgoingMsg = Serial.readStringUntil('\n');
    outgoingMsg.trim();

    if (outgoingMsg.length() > 0) {
      sendLoRaMessage(outgoingMsg);
    }
  }

  delay(10);

  if (deviceConnected && millis() - lastNotifyMs >= NOTIFY_MS) {
    lastNotifyMs = millis();
    Serial.print("Notifying Value: ");
    Serial.println(txValue);
    pTxCharacteristic->setValue(&txValue, 1);
    pTxCharacteristic->notify();
    txValue++;
  }

  // disconnecting
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);                   // give the bluetooth stack the chance to get things ready
    pServer->startAdvertising();  // restart advertising
    Serial.println("Started advertising again...");
    oldDeviceConnected = false;
  }
  // connecting
  if (deviceConnected && !oldDeviceConnected) {
    // do stuff here on connecting
    oldDeviceConnected = true;
  }
}
