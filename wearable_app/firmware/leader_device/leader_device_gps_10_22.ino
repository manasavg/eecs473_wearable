// Heltec V4 Leader: LoRa + BLE + GPS
// GPS is read on the board's GPS RX/TX pins and streamed to Serial (115200) for prototyping.
// Requires library: TinyGPSPlus by Mikal Hart (Library Manager -> "TinyGPSPlus")

//BLE includes
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

//LoRa includes
#include <RadioLib.h>
#include <U8x8lib.h>
#include <Wire.h>

//GPS include
#include <TinyGPS++.h>

//Pin mapping
//---------------------------------------------------------------------------------------------------
//---------------------------------------------------------------------------------------------------
// Heltec V4 Pin Mapping
#define OLED_SDA    17
#define OLED_SCL    18
#define OLED_RST    21
#define VEXT_CTRL   36  // Pull LOW for power rail (also powers the GPS header on many boards)

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

// GPS pins: these are the ESP32's side of the link.
//   GPS_RX_PIN = pin the ESP32 RECEIVES on  -> wire to the GPS module's TX
//   GPS_TX_PIN = pin the ESP32 TRANSMITS on -> wire to the GPS module's RX
// VERIFY these GPIO numbers against your board's pinout for the "GPS RX" / "GPS TX" pins.
#define GPS_RX_PIN  38
#define GPS_TX_PIN  39
#define GPS_BAUD    9600    // Most NEO-6M/M8N/ATGM336H modules default to 9600

// Set to 1 to also echo raw NMEA sentences to Serial (useful for wiring checks)
#define GPS_RAW_ECHO 0

// If the LED pin is shared with a GPS pin, LED writes would corrupt the GPS line, so disable it.
#define USE_BOARD_LED (BOARD_LED != GPS_RX_PIN && BOARD_LED != GPS_TX_PIN)

// Debounce timing
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 250; // ms

bool check = false;
unsigned long lastNotifyMs = 0;
const unsigned long NOTIFY_MS = 3000;

// GPS state
TinyGPSPlus gps;
HardwareSerial &gpsSerial = Serial2;
unsigned long lastGpsPrintMs = 0;
const unsigned long GPS_PRINT_MS = 1000;

// Screen Initialization (U8x8 Non-blocking driver)
U8X8_SSD1306_128X64_NONAME_SW_I2C u8x8(OLED_SCL, OLED_SDA, OLED_RST);
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);

void setLed(uint8_t r, uint8_t g, uint8_t b) {
#if USE_BOARD_LED
  rgbLedWrite(BOARD_LED, r, g, b);
#endif
}

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

//GPS functions
//---------------------------------------------------------------------------------------------------
//---------------------------------------------------------------------------------------------------
// Feed every available byte from the GPS into TinyGPS++. Call often (non-blocking).
void pollGps() {
  while (gpsSerial.available() > 0) {
    char c = gpsSerial.read();
#if GPS_RAW_ECHO
    Serial.write(c);
#endif
    gps.encode(c);
  }
}

// Print a once-per-second GPS status summary to Serial.
void printGpsStatus() {
  if (millis() - lastGpsPrintMs < GPS_PRINT_MS) return;
  lastGpsPrintMs = millis();

  // No bytes at all after 5 s = wiring/power problem, not a sky-view problem
  if (millis() > 5000 && gps.charsProcessed() < 10) {
    Serial.println("[GPS] No data from module. Check power, GND, and TX/RX (try swapping).");
    return;
  }

  Serial.print("[GPS] Sats: ");
  Serial.print(gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
  Serial.print(" | HDOP: ");
  if (gps.hdop.isValid()) Serial.print(gps.hdop.hdop(), 2); else Serial.print("--");

  if (gps.location.isValid()) {
    Serial.print(" | Lat: ");
    Serial.print(gps.location.lat(), 6);
    Serial.print(" | Lng: ");
    Serial.print(gps.location.lng(), 6);
    Serial.print(" | Alt(m): ");
    if (gps.altitude.isValid()) Serial.print(gps.altitude.meters(), 1); else Serial.print("--");
    Serial.print(" | Speed(km/h): ");
    if (gps.speed.isValid()) Serial.print(gps.speed.kmph(), 1); else Serial.print("--");
    Serial.print(" | Fix age(ms): ");
    Serial.print(gps.location.age());
  } else {
    Serial.print(" | No fix yet (searching...)");
  }

  if (gps.date.isValid() && gps.time.isValid()) {
    char buf[24];
    snprintf(buf, sizeof(buf), " | UTC %04d-%02d-%02d %02d:%02d:%02d",
             gps.date.year(), gps.date.month(), gps.date.day(),
             gps.time.hour(), gps.time.minute(), gps.time.second());
    Serial.print(buf);
  }

  Serial.print(" | chars: ");
  Serial.print(gps.charsProcessed());
  Serial.print(" bad checksums: ");
  Serial.println(gps.failedChecksum());
}

// Helper function to transmit LoRa packet
void sendLoRaMessage(String outgoingMsg) {
  setLed(0, 0, 255); // Blue flash

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

  setLed(0, 0, 0); // Turn off LED
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
      for (int k = 0; k < rxValue.length(); k++) {
        Serial.print((uint8_t)rxValue[k]);
      }
      if ((uint8_t)rxValue[0] == 1) {
        check = true;
      }
      Serial.println();
      Serial.println("*********");
    }
  }
};

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

  // 4. SERIAL + GPS
  Serial.begin(115200);
  delay(300);
  Serial.println("HELTEC UP");

  // Larger RX buffer so NMEA isn't lost while radio.transmit() blocks
  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.print("GPS UART started: RX GPIO ");
  Serial.print(GPS_RX_PIN);
  Serial.print(", TX GPIO ");
  Serial.print(GPS_TX_PIN);
  Serial.print(" at ");
  Serial.println(GPS_BAUD);
#if !USE_BOARD_LED
  Serial.println("Note: BOARD_LED shares a GPS pin, so the RGB LED is disabled.");
#endif
  Serial.println("--- HELTEC V4 LORA NODE STARTUP & BLE! ---");

  //BLE setup
  //---------------------------------------------------------------------------------------------------
  //---------------------------------------------------------------------------------------------------
  BLEDevice::init("Leader_Device_LoRa");

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_RX, BLECharacteristic::PROPERTY_WRITE);
  pRxCharacteristic->setCallbacks(new MyCallbacks());

  pService->start();
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
  // 0. GPS: read incoming bytes and print a status line once per second
  pollGps();
  printGpsStatus();

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

      setLed(0, 255, 0); // Green flash
      printScreen("RECEIVED PACKET", str, "RSSI: " + String(rssi) + " dBm");
      delay(150);
      setLed(0, 0, 0);
    }

    radio.startReceive();
  }

  // 2. CHECK BUTTON PRESSES
  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (check) {
      lastDebounceTime = millis();
      sendLoRaMessage("CHECK IN");
      check = false;
    } else if (digitalRead(BTN_OK_PIN) == LOW) {
      lastDebounceTime = millis();
      sendLoRaMessage("OK");
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
    delay(500);
    pServer->startAdvertising();
    Serial.println("Started advertising again...");
    oldDeviceConnected = false;
  }
  // connecting
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = true;
  }
}
