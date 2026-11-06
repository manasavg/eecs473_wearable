// Heltec WiFi LoRa 32 V4. Flash this same sketch on every board.
// GPS TX to GPIO 47, GND to GND, VCC to 5V. Do not use GPIO 16 or 17.
// GPIO 17 is the OLED data line.
//
// Every board boots as a follower and advertises Excursion_XX, where XX is
// the last byte of its Bluetooth MAC. The phone picks one. That connection
// makes the board the leader. Disconnect and it is a follower again.
// The leader asks each other board by id, so the two followers do not
// transmit at the same time. The OLED is only used for check-in.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include <RadioLib.h>
#include <U8x8lib.h>
#include <Wire.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <esp_mac.h>
#include <esp_system.h>

#define OLED_SDA    17
#define OLED_SCL    18
#define OLED_RST    21
#define VEXT_CTRL   36

#define LORA_NSS    8
#define LORA_DIO1   14
#define LORA_RST    12
#define LORA_BUSY   13

#define FEM_EN      2
#define FEM_PA      5
#define BOARD_LED   38
#define FEM_POWER   7

#define BTN_CHECKIN_PIN 4
#define BTN_OK_PIN      6
#define RX_LED_PIN      40

#define GPS_RX_PIN  47
#define GPS_TX_PIN  48
#define GPS_BAUD    9600

#define FOLLOWER_SLOTS 2
#define BLE_PKT_MAX 20
#define BLE_Q 8

unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 250;

bool check = false;
char gpsLine[96];
uint8_t gpsLen = 0;
unsigned long lastNotifyMs = 0;
const unsigned long NOTIFY_MS = 3000;

bool selfFix = false;
double selfLat = 0;
double selfLon = 0;

struct FollowerSlot {
  uint8_t id;
  bool used;
  bool fix;
  double lat;
  double lon;
  unsigned long posMs;
};

FollowerSlot slots[FOLLOWER_SLOTS];
const unsigned long FOLLOWER_POS_TTL_MS = 15000;
uint16_t rangeLimitM = 0;
unsigned long lastBleNotifyMs = 0;
unsigned long lastPhoneMs = 0;
unsigned long nextPollMs = 0;
unsigned long lastFindMs = 0;
uint8_t pollSlot = 0;
const unsigned long PHONE_EVERY_MS = 1000;

bool radioTx = false;
unsigned long radioTxMs = 0;
char pendingMsg[80];
bool pendingMsgReady = false;
char replyBuf[80];
bool replyArmed = false;
unsigned long replyAt = 0;

char usbLine[80];
uint8_t usbLen = 0;
bool advRestartPending = false;
unsigned long restartAdvAt = 0;
char scr1[17] = "";
char scr2[17] = "";
char scr3[17] = "";
bool scrDirty = false;
unsigned long lastScrMs = 0;

uint8_t bleQ[BLE_Q][BLE_PKT_MAX];
uint8_t bleQLen[BLE_Q];
uint8_t bleHead = 0;
uint8_t bleCount = 0;

unsigned long rxLedOnTime = 0;
bool rxLedActive = false;
const unsigned long rxLedDuration = 150;
bool rangeAlarm = false;

uint8_t nodeId = 1;
char bleName[20] = "Excursion_01";
volatile bool wantLeader = false;
bool isLeader = false;

U8X8_SSD1306_128X64_NONAME_SW_I2C u8x8(OLED_SCL, OLED_SDA, OLED_RST);
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);

BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic;
bool deviceConnected = false;
bool oldDeviceConnected = false;
uint8_t txValue = 0;

#define SERVICE_UUID           "20b723dd-215e-4424-bd75-746a902408bb"
#define CHARACTERISTIC_UUID_RX "0be48bf3-86c4-4d13-8e2c-2ac0a569817c"
#define CHARACTERISTIC_UUID_TX "209989cd-1fc7-4eb1-979e-690ba55053da"

void clipCopy(char *dst, const char *src) {
  size_t n = 0;
  if (src) {
    while (src[n] && n < 16) {
      dst[n] = src[n];
      n++;
    }
  }
  dst[n] = 0;
}

void drawScreen() {
  u8x8.clearDisplay();
  u8x8.setCursor(0, 0);
  u8x8.print(scr1);
  u8x8.setCursor(0, 2);
  u8x8.print(scr2);
  if (scr3[0]) {
    u8x8.setCursor(0, 4);
    u8x8.print(scr3);
  }
  scrDirty = false;
  lastScrMs = millis();
}

void printScreen(String line1, String line2, String line3 = "") {
  char a[17];
  char b[17];
  char c[17];
  clipCopy(a, line1.c_str());
  clipCopy(b, line2.c_str());
  clipCopy(c, line3.c_str());
  if (strcmp(a, scr1) == 0 && strcmp(b, scr2) == 0 && strcmp(c, scr3) == 0) return;
  memcpy(scr1, a, 17);
  memcpy(scr2, b, 17);
  memcpy(scr3, c, 17);
  scrDirty = true;
}

void showRangeLight() {
  if (!isLeader && rangeAlarm) {
    rgbLedWrite(BOARD_LED, 255, 0, 0);
    digitalWrite(RX_LED_PIN, HIGH);
  } else {
    rgbLedWrite(BOARD_LED, 0, 0, 0);
    digitalWrite(RX_LED_PIN, LOW);
  }
}

void applyRangeAlarm(bool on) {
  rangeAlarm = on;
  if (!radioTx && !rxLedActive) showRangeLight();
}

bool startLoRa(const char *msg) {
  if (radioTx || msg == NULL || msg[0] == 0) return false;
  Serial.print("\n[Transmitting]: ");
  Serial.println(msg);
  rgbLedWrite(BOARD_LED, 0, 0, 255);
  digitalWrite(FEM_PA, HIGH);
  int txState = radio.startTransmit(msg);
  if (txState != RADIOLIB_ERR_NONE) {
    digitalWrite(FEM_PA, LOW);
    showRangeLight();
    Serial.print(" -> TX start failed, code: ");
    Serial.println(txState);
    radio.startReceive();
    return false;
  }
  radioTx = true;
  radioTxMs = millis();
  return true;
}

void queueLoRa(const char *msg) {
  if (msg == NULL || msg[0] == 0) return;
  strncpy(pendingMsg, msg, sizeof(pendingMsg) - 1);
  pendingMsg[sizeof(pendingMsg) - 1] = 0;
  pendingMsgReady = true;
}

void finishTxIfDone() {
  if (!radioTx) return;
  bool irq = digitalRead(LORA_DIO1) == HIGH;
  bool stuck = millis() - radioTxMs > 3000;
  if (!irq && !stuck) return;
  radio.finishTransmit();
  digitalWrite(FEM_PA, LOW);
  radioTx = false;
  Serial.println(" -> TX done");
  showRangeLight();
  radio.startReceive();
}

void scheduleReply(const char *msg, unsigned long delayMs) {
  if (msg == NULL || msg[0] == 0) return;
  strncpy(replyBuf, msg, sizeof(replyBuf) - 1);
  replyBuf[sizeof(replyBuf) - 1] = 0;
  replyAt = millis() + delayMs;
  replyArmed = true;
}

void serviceReply() {
  if (isLeader || wantLeader || !replyArmed) return;
  if (radioTx || pendingMsgReady) return;
  if ((long)(millis() - replyAt) < 0) return;
  replyArmed = false;
  queueLoRa(replyBuf);
}

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) {
    (void)server;
    deviceConnected = true;
    wantLeader = true;
    Serial.println("Phone connected. This board is the leader.");
  }

  void onDisconnect(BLEServer *server) {
    (void)server;
    deviceConnected = false;
    wantLeader = false;
    Serial.println("Phone disconnected. This board is a follower.");
  }
};

class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue();
    if (rxValue.length() == 0) return;
    Serial.print("Received Value: ");
    for (unsigned int n = 0; n < rxValue.length(); n++) {
      Serial.print((uint8_t)rxValue[n]);
    }
    Serial.println();
    if (rxValue.length() >= 4 && (uint8_t)rxValue[0] == 1 && (uint8_t)rxValue[1] == 1) {
      uint16_t meters = (uint8_t)rxValue[3];
      if (rxValue.length() >= 5) meters |= (uint16_t)(uint8_t)rxValue[4] << 8;
      if (meters < 1) meters = 1;
      if (meters > 2000) meters = 2000;
      rangeLimitM = meters;
    } else if ((uint8_t)rxValue[0] == 1) {
      check = true;
    }
  }
};

void bleNotify(const uint8_t *data, size_t len) {
  if (data == NULL || len == 0 || len > BLE_PKT_MAX) return;
  if (bleCount >= BLE_Q) {
    bleHead = (uint8_t)((bleHead + 1) % BLE_Q);
    bleCount--;
  }
  uint8_t tail = (uint8_t)((bleHead + bleCount) % BLE_Q);
  memcpy(bleQ[tail], data, len);
  bleQLen[tail] = (uint8_t)len;
  bleCount++;
}

void pollBleNotify() {
  if (!deviceConnected || pTxCharacteristic == NULL || bleCount == 0) return;
  if (lastBleNotifyMs != 0 && millis() - lastBleNotifyMs < 60) return;
  pTxCharacteristic->setValue(bleQ[bleHead], bleQLen[bleHead]);
  pTxCharacteristic->notify();
  bleHead = (uint8_t)((bleHead + 1) % BLE_Q);
  bleCount--;
  lastBleNotifyMs = millis();
}

void writeLatLon(uint8_t *pkt, int fixIndex, bool fix, double lat, double lon) {
  int32_t latE7 = 0;
  int32_t lonE7 = 0;
  if (fix) {
    double latScaled = lat * 10000000.0;
    double lonScaled = lon * 10000000.0;
    latE7 = (int32_t)(latScaled >= 0 ? latScaled + 0.5 : latScaled - 0.5);
    lonE7 = (int32_t)(lonScaled >= 0 ? lonScaled + 0.5 : lonScaled - 0.5);
  }
  pkt[fixIndex] = fix ? 1 : 0;
  int latAt = fixIndex + 1;
  int lonAt = fixIndex + 5;
  pkt[latAt] = (uint8_t)(latE7 & 0xFF);
  pkt[latAt + 1] = (uint8_t)((latE7 >> 8) & 0xFF);
  pkt[latAt + 2] = (uint8_t)((latE7 >> 16) & 0xFF);
  pkt[latAt + 3] = (uint8_t)((latE7 >> 24) & 0xFF);
  pkt[lonAt] = (uint8_t)(lonE7 & 0xFF);
  pkt[lonAt + 1] = (uint8_t)((lonE7 >> 8) & 0xFF);
  pkt[lonAt + 2] = (uint8_t)((lonE7 >> 16) & 0xFF);
  pkt[lonAt + 3] = (uint8_t)((lonE7 >> 24) & 0xFF);
}

void notifyGps(bool fix, double lat, double lon) {
  uint8_t pkt[10];
  pkt[0] = 'G';
  writeLatLon(pkt, 1, fix, lat, lon);
  bleNotify(pkt, 10);
}

void notifyFollower(uint8_t id, bool fix, double lat, double lon) {
  uint8_t pkt[11];
  pkt[0] = 'F';
  pkt[1] = id;
  writeLatLon(pkt, 2, fix, lat, lon);
  bleNotify(pkt, 11);
}

void notifySeparation(uint8_t id, bool known, double meters) {
  if (known && (meters < 0.0 || meters >= 1000000.0)) known = false;
  uint32_t cm = known ? (uint32_t)(meters * 100.0 + 0.5) : 0xFFFFFFFFu;
  uint8_t pkt[6];
  pkt[0] = 'M';
  pkt[1] = id;
  pkt[2] = (uint8_t)(cm & 0xFF);
  pkt[3] = (uint8_t)((cm >> 8) & 0xFF);
  pkt[4] = (uint8_t)((cm >> 16) & 0xFF);
  pkt[5] = (uint8_t)((cm >> 24) & 0xFF);
  bleNotify(pkt, 6);
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

int findSlot(uint8_t id) {
  for (int i = 0; i < FOLLOWER_SLOTS; i++) {
    if (slots[i].used && slots[i].id == id) return i;
  }
  return -1;
}

int freeSlot() {
  for (int i = 0; i < FOLLOWER_SLOTS; i++) {
    if (!slots[i].used) return i;
  }
  return -1;
}

int countSlots() {
  int n = 0;
  for (int i = 0; i < FOLLOWER_SLOTS; i++) {
    if (slots[i].used) n++;
  }
  return n;
}

void clearSlots() {
  for (int i = 0; i < FOLLOWER_SLOTS; i++) slots[i].used = false;
}

void noteFollower(int id, bool updateFix, bool fix, double lat, double lon) {
  if (id <= 0 || id > 255 || id == (int)nodeId) return;
  int idx = findSlot((uint8_t)id);
  if (idx < 0) {
    idx = freeSlot();
    if (idx < 0) return;
    slots[idx].id = (uint8_t)id;
    slots[idx].used = true;
    slots[idx].fix = false;
  }
  if (updateFix) {
    slots[idx].fix = fix;
    if (fix) {
      slots[idx].lat = lat;
      slots[idx].lon = lon;
    }
  }
  slots[idx].posMs = millis();
}

void expireFollowers() {
  for (int i = 0; i < FOLLOWER_SLOTS; i++) {
    if (!slots[i].used || slots[i].posMs == 0) continue;
    if (millis() - slots[i].posMs <= FOLLOWER_POS_TTL_MS) continue;
    uint8_t id = slots[i].id;
    slots[i].used = false;
    slots[i].fix = false;
    uint8_t drop[2] = { 'X', id };
    bleNotify(drop, 2);
  }
}

void pushPhone() {
  notifyGps(selfFix, selfLat, selfLon);
  for (int i = 0; i < FOLLOWER_SLOTS; i++) {
    if (!slots[i].used) continue;
    notifyFollower(slots[i].id, slots[i].fix, slots[i].lat, slots[i].lon);
    bool known = selfFix && slots[i].fix;
    double meters = known ? haversineMeters(selfLat, selfLon, slots[i].lat, slots[i].lon) : 0.0;
    notifySeparation(slots[i].id, known, meters);
  }
}

bool readId(const String &text, int from, int *id, int *next) {
  if (from < 0 || from >= text.length() || !isDigit(text[from])) return false;
  int value = 0;
  int i = from;
  while (i < text.length() && isDigit(text[i])) {
    value = value * 10 + (text[i] - '0');
    if (value > 255) return false;
    i++;
  }
  *id = value;
  *next = i;
  return true;
}

void handleLeaderRx(const String &msg) {
  String upper = msg;
  upper.toUpperCase();
  upper.trim();
  if (upper == "OK" || upper.startsWith("OK ")) {
    int id = 0;
    int next = 0;
    bool hasId = upper.startsWith("OK ") && readId(upper, 3, &id, &next);
    if (hasId) {
      uint8_t pkt[3] = { 'O', 'K', (uint8_t)id };
      bleNotify(pkt, 3);
    } else {
      uint8_t pkt[2] = { 'O', 'K' };
      bleNotify(pkt, 2);
    }
    printScreen("CHECK IN", "OK", "");
    drawScreen();
    return;
  }
  if (upper.startsWith("HERE ")) {
    int id = 0;
    int next = 0;
    if (readId(upper, 5, &id, &next)) noteFollower(id, false, false, 0, 0);
    return;
  }
  if (!upper.startsWith("POS ")) return;
  int id = 0;
  int next = 0;
  if (!readId(upper, 4, &id, &next)) return;
  String rest = upper.substring(next);
  rest.trim();
  if (rest.startsWith("NOFIX") || rest.length() == 0) {
    noteFollower(id, true, false, 0, 0);
    return;
  }
  int splitAt = rest.indexOf(' ');
  if (splitAt < 1) {
    noteFollower(id, true, false, 0, 0);
    return;
  }
  double lat = rest.substring(0, splitAt).toFloat();
  double lon = rest.substring(splitAt + 1).toFloat();
  if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
    noteFollower(id, true, false, 0, 0);
    return;
  }
  noteFollower(id, true, true, lat, lon);
}

void sendPosition() {
  replyArmed = false;
  if (!selfFix) {
    char body[24];
    snprintf(body, sizeof(body), "POS %u NOFIX", nodeId);
    queueLoRa(body);
    return;
  }
  String body = "POS " + String(nodeId) + " " + String(selfLat, 6) + " " + String(selfLon, 6);
  queueLoRa(body.c_str());
}

void handleFollowerRx(const String &msg) {
  if (wantLeader) return;
  String upper = msg;
  upper.toUpperCase();
  upper.trim();
  if (upper == "CHECK IN" || upper.startsWith("CHECK IN ")) {
    printScreen("CHECK IN", "", "");
    drawScreen();
  }
  if (upper == "FIND" || upper.startsWith("FIND ")) {
    char here[16];
    snprintf(here, sizeof(here), "HERE %u", nodeId);
    unsigned long waitMs = 80UL + (unsigned long)(nodeId % 5) * 280UL + (unsigned long)(esp_random() % 150UL);
    scheduleReply(here, waitMs);
    return;
  }
  if (!upper.startsWith("PING ")) return;
  int id = 0;
  int next = 0;
  if (!readId(upper, 5, &id, &next)) return;
  if (id != (int)nodeId) return;
  String tail = upper.substring(next);
  if (tail.indexOf("FAR") >= 0) applyRangeAlarm(true);
  else if (tail.indexOf("NEAR") >= 0) applyRangeAlarm(false);
  sendPosition();
}

void leaderRadio() {
  if (!isLeader || radioTx || pendingMsgReady) return;
  if (nextPollMs != 0 && (long)(millis() - nextPollMs) < 0) return;
  int known = countSlots();
  bool dueFind = known == 0
    || (known < FOLLOWER_SLOTS && millis() - lastFindMs >= 8000)
    || millis() - lastFindMs >= 20000;
  if (dueFind) {
    lastFindMs = millis();
    nextPollMs = millis() + 2200;
    startLoRa("FIND");
    return;
  }
  for (int n = 0; n < FOLLOWER_SLOTS; n++) {
    int i = (pollSlot + n) % FOLLOWER_SLOTS;
    if (!slots[i].used) continue;
    pollSlot = (uint8_t)((i + 1) % FOLLOWER_SLOTS);
    const char *tail = "";
    if (rangeLimitM > 0 && selfFix && slots[i].fix) {
      double meters = haversineMeters(selfLat, selfLon, slots[i].lat, slots[i].lon);
      tail = meters > (double)rangeLimitM ? " FAR" : " NEAR";
    }
    char ping[32];
    snprintf(ping, sizeof(ping), "PING %u%s", slots[i].id, tail);
    nextPollMs = millis() + 900;
    startLoRa(ping);
    return;
  }
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
  if (!star || !star[1] || !star[2]) return false;
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

void applyRole() {
  if (wantLeader == isLeader) return;
  isLeader = wantLeader;
  replyArmed = false;
  pendingMsgReady = false;
  rangeAlarm = false;
  clearSlots();
  nextPollMs = 0;
  lastFindMs = 0;
  pollSlot = 0;
  if (!isLeader) check = false;
  if (!radioTx && !rxLedActive) showRangeLight();
  Serial.println(isLeader ? "ROLE LEADER" : "ROLE FOLLOWER");
}

void setup() {
  pinMode(VEXT_CTRL, OUTPUT);
  digitalWrite(VEXT_CTRL, LOW);
  delay(100);

  pinMode(RX_LED_PIN, OUTPUT);
  digitalWrite(RX_LED_PIN, LOW);

  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW);
  delay(20);
  digitalWrite(OLED_RST, HIGH);
  delay(20);

  u8x8.begin();
  u8x8.setPowerSave(0);
  u8x8.setFlipMode(1);
  u8x8.setFont(u8x8_font_chroma48medium8_r);

  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);
  delay(300);

  uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
  esp_read_mac(mac, ESP_MAC_BT);
  nodeId = mac[5] == 0 ? 1 : mac[5];
  snprintf(bleName, sizeof(bleName), "Excursion_%02X", nodeId);
  Serial.print("NODE ");
  Serial.print(bleName);
  Serial.print(" MAC ");
  for (int i = 0; i < 6; i++) {
    if (mac[i] < 16) Serial.print('0');
    Serial.print(mac[i], HEX);
    if (i < 5) Serial.print(':');
  }
  Serial.println();
  Serial.println("GPS UART is Serial2 RX GPIO 47 at 9600. NEO-6M TX goes there.");
  Serial2.setRxBufferSize(2048);
  Serial2.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  BLEDevice::init(bleName);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pTxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);
  pTxCharacteristic->addDescriptor(new BLE2902());
  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_RX, BLECharacteristic::PROPERTY_WRITE);
  pRxCharacteristic->setCallbacks(new MyCallbacks());
  uint8_t bleRoom[BLE_PKT_MAX];
  memset(bleRoom, 0, sizeof(bleRoom));
  pTxCharacteristic->setValue(bleRoom, sizeof(bleRoom));
  pService->start();
  pServer->getAdvertising()->start();
  Serial.println("Advertising. Waiting for the phone to choose this board.");

  pinMode(FEM_POWER, OUTPUT);
  digitalWrite(FEM_POWER, HIGH);
  delay(10);
  pinMode(FEM_EN, OUTPUT);
  digitalWrite(FEM_EN, HIGH);
  pinMode(FEM_PA, OUTPUT);
  digitalWrite(FEM_PA, LOW);
  delay(10);

  pinMode(BTN_CHECKIN_PIN, INPUT_PULLUP);
  pinMode(BTN_OK_PIN, INPUT_PULLUP);

  int state = radio.begin(915.0, 125.0, 9, 5, 0x12, 10, 8, 1.8);
  if (state == RADIOLIB_ERR_NONE) {
    Serial.println("SX1262 Init Success!");
  } else {
    Serial.print("SX1262 Init Failed, Code: ");
    Serial.println(state);
    while (true);
  }
  radio.setDio2AsRfSwitch(true);
  radio.startReceive();
  Serial.println("ROLE FOLLOWER");
}

void loop() {
  applyRole();
  pollGpsUart();
  finishTxIfDone();
  if (!radioTx && pendingMsgReady) {
    if (startLoRa(pendingMsg)) pendingMsgReady = false;
  }
  serviceReply();

  if (!radioTx && digitalRead(LORA_DIO1) == HIGH) {
    String str;
    int radioState = radio.readData(str);
    radio.startReceive();
    if (radioState == RADIOLIB_ERR_NONE && str.length() > 0) {
      str.trim();
      Serial.print("\n[Received]: \"");
      Serial.print(str);
      Serial.print("\" | RSSI: ");
      Serial.print(radio.getRSSI());
      Serial.println(" dBm");
      rgbLedWrite(BOARD_LED, 0, 255, 0);
      digitalWrite(RX_LED_PIN, HIGH);
      rxLedOnTime = millis();
      rxLedActive = true;
      if (isLeader) handleLeaderRx(str);
      else handleFollowerRx(str);
    }
  }

  if (rxLedActive && (millis() - rxLedOnTime >= rxLedDuration)) {
    rxLedActive = false;
    showRangeLight();
  }

  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (isLeader && check) {
      lastDebounceTime = millis();
      queueLoRa("CHECK IN");
      printScreen("CHECK IN", "Sending", "");
      drawScreen();
      check = false;
    } else if (!isLeader && digitalRead(BTN_OK_PIN) == LOW) {
      lastDebounceTime = millis();
      char okMsg[16];
      snprintf(okMsg, sizeof(okMsg), "OK %u", nodeId);
      queueLoRa(okMsg);
      printScreen("OK", "Sending", "");
      drawScreen();
    } else if (isLeader && digitalRead(BTN_OK_PIN) == LOW) {
      lastDebounceTime = millis();
      queueLoRa("OK");
    }
  }

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (usbLen > 0) {
        usbLine[usbLen] = 0;
        queueLoRa(usbLine);
        usbLen = 0;
      }
    } else if (usbLen < sizeof(usbLine) - 1) {
      usbLine[usbLen++] = c;
    }
  }

  if (isLeader && deviceConnected && millis() - lastNotifyMs >= NOTIFY_MS) {
    lastNotifyMs = millis();
    bleNotify(&txValue, 1);
    txValue++;
  }

  if (isLeader && millis() - lastPhoneMs >= PHONE_EVERY_MS) {
    lastPhoneMs = millis();
    expireFollowers();
    pushPhone();
  }

  if (isLeader) leaderRadio();

  if (!deviceConnected && oldDeviceConnected && !advRestartPending) {
    advRestartPending = true;
    restartAdvAt = millis() + 500;
  }
  if (advRestartPending && (long)(millis() - restartAdvAt) >= 0) {
    pServer->startAdvertising();
    Serial.println("Started advertising again...");
    advRestartPending = false;
    oldDeviceConnected = false;
  }
  if (deviceConnected && !oldDeviceConnected) {
    advRestartPending = false;
    oldDeviceConnected = true;
  }

  pollBleNotify();
  pollGpsUart();
  yield();
}
