// Heltec V4 leader: LoRa, BLE, and a NEO-6M GPS on Serial2.
// GPS TX wires to GPIO 47. GND to GND. Module VCC to 5V.
// Do not use GPIO 16 or 17. GPIO 17 is the OLED data line.
// The follower sketch sends "POS <lat> <lon>" over LoRa. This board
// computes the distance between the two fixes and notifies the phone.

//BLE includes
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

//LoRa includes
#include <RadioLib.h>
#include <U8x8lib.h>
#include <Wire.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

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

#define RX_LED_PIN  40 // this the RX LED that is use to notify the wearable 


// NEO-6M default baud is 9600. TX of the module goes to GPS_RX_PIN.
// GPS_TX_PIN is unused. Do not wire it. GPIO 17 stays the OLED data line.
#define GPS_RX_PIN      47
#define GPS_TX_PIN      48
#define GPS_BAUD        9600

// Debounce timing
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 250; // ms

bool check = false;
int i = 0;
char gpsLine[96];
uint8_t gpsLen = 0;
unsigned long lastNotifyMs = 0;
const unsigned long NOTIFY_MS = 3000;

bool selfFix = false;
double selfLat = 0;
double selfLon = 0;
bool followerFix = false;
double followerLat = 0;
double followerLon = 0;
unsigned long followerPosMs = 0;
const unsigned long FOLLOWER_POS_TTL_MS = 15000;
unsigned long lastSepNotifyMs = 0;
bool lastSepKnown = false;
double lastSepMeters = -1;

// this is the timeer logic for the led and buzzer
unsigned long rxLedOnTime = 0;
bool rxLedActive = false;
const unsigned long rxLedDuration = 150; // ms

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
      if ((uint8_t)rxValue[i] == 1){ // this could be a bug?? need to set this directly to 0
        check = true;
      }
      Serial.println();
      Serial.println("*********");
    }
  }
};

// 'G', fix byte, int32 latitude * 1e7, int32 longitude * 1e7. Both little-endian.
void notifyGps(bool fix, double lat, double lon) {
  if (!deviceConnected || pTxCharacteristic == NULL) return;
  int32_t latE7 = 0;
  int32_t lonE7 = 0;
  if (fix) {
    double latScaled = lat * 10000000.0;
    double lonScaled = lon * 10000000.0;
    latE7 = (int32_t)(latScaled >= 0 ? latScaled + 0.5 : latScaled - 0.5);
    lonE7 = (int32_t)(lonScaled >= 0 ? lonScaled + 0.5 : lonScaled - 0.5);
  }
  uint8_t pkt[10];
  pkt[0] = 'G';
  pkt[1] = fix ? 1 : 0;
  pkt[2] = (uint8_t)(latE7 & 0xFF);
  pkt[3] = (uint8_t)((latE7 >> 8) & 0xFF);
  pkt[4] = (uint8_t)((latE7 >> 16) & 0xFF);
  pkt[5] = (uint8_t)((latE7 >> 24) & 0xFF);
  pkt[6] = (uint8_t)(lonE7 & 0xFF);
  pkt[7] = (uint8_t)((lonE7 >> 8) & 0xFF);
  pkt[8] = (uint8_t)((lonE7 >> 16) & 0xFF);
  pkt[9] = (uint8_t)((lonE7 >> 24) & 0xFF);
  pTxCharacteristic->setValue(pkt, 10);
  pTxCharacteristic->notify();
  if (fix) {
    Serial.print("Phone notified GPS: ");
    Serial.print(lat, 6);
    Serial.print(", ");
    Serial.println(lon, 6);
    printScreen("GPS FIX", String(lat, 5), String(lon, 5));
  } else {
    Serial.println("Phone notified GPS: no fix");
    printScreen("GPS", "No fix");
  }
}

// 'M' + uint32 centimeters, little-endian. 0xFFFFFFFF means no distance.
void notifySeparation(bool known, double meters) {
  if (known && (meters < 0.0 || meters >= 1000000.0)) known = false;
  uint32_t cm = known ? (uint32_t)(meters * 100.0 + 0.5) : 0xFFFFFFFFu;
  if (deviceConnected && pTxCharacteristic != NULL) {
    uint8_t pkt[5];
    pkt[0] = 'M';
    pkt[1] = (uint8_t)(cm & 0xFF);
    pkt[2] = (uint8_t)((cm >> 8) & 0xFF);
    pkt[3] = (uint8_t)((cm >> 16) & 0xFF);
    pkt[4] = (uint8_t)((cm >> 24) & 0xFF);
    pTxCharacteristic->setValue(pkt, 5);
    pTxCharacteristic->notify();
  }
  if (known) {
    Serial.print("Phone notified distance: ");
    Serial.print(meters, 1);
    Serial.println(" m");
    printScreen("DISTANCE", String(meters, 1) + " m");
  } else {
    Serial.println("Phone notified distance: no fix");
    printScreen("DISTANCE", "No fix");
  }
}

double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
  const double radius = 6371000.0;
  const double toRad = 0.017453292519943295;
  double dLat = (lat2 - lat1) * toRad;
  double dLon = (lon2 - lon1) * toRad;
  double a = sin(dLat / 2.0) * sin(dLat / 2.0)
    + cos(lat1 * toRad) * cos(lat2 * toRad) * sin(dLon / 2.0) * sin(dLon / 2.0);
  if (a < 0.0) a = 0.0;
  if (a > 1.0) a = 1.0;
  return 2.0 * radius * asin(sqrt(a));
}

void refreshDistance() {
  if (followerFix && followerPosMs != 0 && millis() - followerPosMs > FOLLOWER_POS_TTL_MS) {
    followerFix = false;
  }
  bool known = selfFix && followerFix;
  double meters = known ? haversineMeters(selfLat, selfLon, followerLat, followerLon) : 0.0;
  bool changed = known != lastSepKnown || fabs(meters - lastSepMeters) >= 1.0;
  if (!changed && millis() - lastSepNotifyMs < 2000) return;
  lastSepKnown = known;
  lastSepMeters = meters;
  lastSepNotifyMs = millis();
  notifySeparation(known, meters);
}

bool handleFollowerPosition(const String &msg) {
  String upper = msg;
  upper.toUpperCase();
  if (!upper.startsWith("POS")) return false;
  String rest = msg.substring(3);
  rest.trim();
  String restUpper = rest;
  restUpper.toUpperCase();
  if (restUpper == "NOFIX" || rest.length() == 0) {
    followerFix = false;
    followerPosMs = millis();
    refreshDistance();
    return true;
  }
  int splitAt = rest.indexOf(' ');
  if (splitAt < 1) return true;
  double lat = rest.substring(0, splitAt).toFloat();
  double lon = rest.substring(splitAt + 1).toFloat();
  if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
    followerFix = false;
  } else {
    followerFix = true;
    followerLat = lat;
    followerLon = lon;
  }
  followerPosMs = millis();
  refreshDistance();
  return true;
}

bool nmeaField(const char *line, int index, char *out, size_t outLen) {
  const char *p = line;
  if (*p == '$') p++;
  int field = 0;
  while (*p && field < index) {
    if (*p == '*') return false;
    if (*p == ',') field++;
    p++;
  }
  if (field != index || outLen == 0) return false;
  size_t n = 0;
  while (*p && *p != ',' && *p != '*' && n + 1 < outLen) out[n++] = *p++;
  out[n] = 0;
  return true;
}

bool nmeaEndsWith(const char *s, const char *suffix) {
  size_t n = strlen(s);
  size_t m = strlen(suffix);
  if (n < m) return false;
  return strcmp(s + (n - m), suffix) == 0;
}

bool nmeaHexNibble(char c, uint8_t *out) {
  if (c >= '0' && c <= '9') { *out = (uint8_t)(c - '0'); return true; }
  if (c >= 'A' && c <= 'F') { *out = (uint8_t)(c - 'A' + 10); return true; }
  if (c >= 'a' && c <= 'f') { *out = (uint8_t)(c - 'a' + 10); return true; }
  return false;
}

bool nmeaChecksumOk(const char *line) {
  const char *star = strchr(line, '*');
  if (!star) return true;
  uint8_t hi = 0;
  uint8_t lo = 0;
  if (!nmeaHexNibble(star[1], &hi) || !nmeaHexNibble(star[2], &lo)) return false;
  uint8_t expect = (uint8_t)((hi << 4) | lo);
  uint8_t got = 0;
  for (const char *p = line; *p && p != star; p++) {
    if (*p == '$') continue;
    got ^= (uint8_t)*p;
  }
  return got == expect;
}

bool nmeaToDegrees(const char *raw, const char *hemi, double *out) {
  if (!raw[0] || !hemi[0]) return false;
  double v = atof(raw);
  double whole = floor(v / 100.0);
  double minutes = v - whole * 100.0;
  if (minutes < 0.0 || minutes >= 60.0) return false;
  double deg = whole + minutes / 60.0;
  char h = hemi[0];
  if (h == 'S' || h == 'W') deg = -deg;
  else if (h != 'N' && h != 'E') return false;
  if (h == 'N' || h == 'S') {
    if (deg < -90.0 || deg > 90.0) return false;
  } else if (deg < -180.0 || deg > 180.0) {
    return false;
  }
  *out = deg;
  return true;
}

void handleNmea(const char *line) {
  Serial.print("GPS: ");
  Serial.println(line);
  if (line[0] != '$' || !nmeaChecksumOk(line)) return;

  char type[12];
  if (!nmeaField(line, 0, type, sizeof(type))) return;
  bool rmc = nmeaEndsWith(type, "RMC");
  bool gga = nmeaEndsWith(type, "GGA");
  if (!rmc && !gga) return;

  char status[8];
  char latRaw[16];
  char ns[4];
  char lonRaw[16];
  char ew[4];
  bool fix = false;
  double lat = 0;
  double lon = 0;

  if (rmc) {
    if (!nmeaField(line, 2, status, sizeof(status))) return;
    fix = status[0] == 'A';
    if (fix) {
      if (!nmeaField(line, 3, latRaw, sizeof(latRaw)) || !nmeaField(line, 4, ns, sizeof(ns))) return;
      if (!nmeaField(line, 5, lonRaw, sizeof(lonRaw)) || !nmeaField(line, 6, ew, sizeof(ew))) return;
      if (!nmeaToDegrees(latRaw, ns, &lat) || !nmeaToDegrees(lonRaw, ew, &lon)) fix = false;
    }
  } else {
    if (!nmeaField(line, 6, status, sizeof(status))) return;
    fix = atoi(status) > 0;
    if (fix) {
      if (!nmeaField(line, 2, latRaw, sizeof(latRaw)) || !nmeaField(line, 3, ns, sizeof(ns))) return;
      if (!nmeaField(line, 4, lonRaw, sizeof(lonRaw)) || !nmeaField(line, 5, ew, sizeof(ew))) return;
      if (!nmeaToDegrees(latRaw, ns, &lat) || !nmeaToDegrees(lonRaw, ew, &lon)) fix = false;
    }
  }

  selfFix = fix;
  if (fix) {
    selfLat = lat;
    selfLon = lon;
  }
  notifyGps(fix, lat, lon);
  refreshDistance();
}

void pollGpsUart() {
  while (Serial2.available() > 0) {
    char c = (char)Serial2.read();
    if (c == '\n' || c == '\r') {
      if (gpsLen > 0) {
        gpsLine[gpsLen] = 0;
        handleNmea(gpsLine);
        gpsLen = 0;
      }
    } else if (gpsLen < sizeof(gpsLine) - 1) {
      gpsLine[gpsLen++] = c;
    } else {
      gpsLen = 0;
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

  // this is the LED buzzer
  pinMode(RX_LED_PIN, OUTPUT);
  digitalWrite(RX_LED_PIN, LOW);

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
  Serial2.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("GPS UART is Serial2 RX GPIO 47 at 9600. NEO-6M TX goes there.");
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
  pollGpsUart();
  if (followerFix && followerPosMs != 0 && millis() - followerPosMs > FOLLOWER_POS_TTL_MS) {
    followerFix = false;
    refreshDistance();
  }

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
      handleFollowerPosition(msg);

      // LED and buzzer notification
      rgbLedWrite(BOARD_LED, 0, 255, 0);   // Green flash
      digitalWrite(RX_LED_PIN, HIGH);      // External LED on
      printScreen("RECEIVED PACKET", str, "RSSI: " + String(rssi) + " dBm");
      rxLedOnTime = millis();
      rxLedActive = true;
    }

    radio.startReceive();
  }


  // this turns both the led and the buzzer off after the duration has passed
  if (rxLedActive && (millis() - rxLedOnTime >= rxLedDuration)) {
  rgbLedWrite(BOARD_LED, 0, 0, 0);
  digitalWrite(RX_LED_PIN, LOW);
  rxLedActive = false;
  }

  // 2. CHECK BUTTON PRESSES
  if ((millis() - lastDebounceTime) > debounceDelay) {
    // Check "CHECK IN" Button (GPIO 7)
    if (check) {
      lastDebounceTime = millis();
      sendLoRaMessage("CHECK IN");
      check = false;
    }else if (digitalRead(BTN_OK_PIN) == LOW) {
      lastDebounceTime = millis();
      sendLoRaMessage("OK");
    }
  }

  //MAYBE CHECK THIS AGAIN: (this could be the right code instead)
  //   if (check || digitalRead(BTN_CHECKIN_PIN) == LOW) {
  //   lastDebounceTime = millis();
  //   sendLoRaMessage("CHECK IN");
  //   check = false;
  // } else if (digitalRead(BTN_OK_PIN) == LOW) {
  //   lastDebounceTime = millis();
  //   sendLoRaMessage("OK");
  // }

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
