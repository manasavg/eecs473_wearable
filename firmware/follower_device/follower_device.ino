// Heltec V4 follower: LoRa and a NEO-6M GPS on Serial2.
// GPS TX wires to GPIO 47. GND to GND. Module VCC to 5V.
// Do not use GPIO 16 or 17. GPIO 17 is the OLED data line.
// This board does not use Bluetooth. It stays in receive and sends
// "POS <lat> <lon>" only after the leader sends "PING".
// The OK button still sends LoRa "OK" for check-in.

#include <RadioLib.h>
#include <U8x8lib.h>
#include <Wire.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

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

#define BTN_OK_PIN  6
#define RX_LED_PIN  40

#define GPS_RX_PIN  47
#define GPS_TX_PIN  48
#define GPS_BAUD    9600

unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 250;

unsigned long rxLedOnTime = 0;
bool rxLedActive = false;
const unsigned long rxLedDuration = 150;

char gpsLine[96];
uint8_t gpsLen = 0;
bool gpsFix = false;
double gpsLat = 0;
double gpsLon = 0;

U8X8_SSD1306_128X64_NONAME_SW_I2C u8x8(OLED_SCL, OLED_SDA, OLED_RST);
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);

void flushGps() {
  while (Serial2.available() > 0) Serial2.read();
  gpsLen = 0;
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

void sendLoRaMessage(String outgoingMsg) {
  rgbLedWrite(BOARD_LED, 0, 0, 255);
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

  rgbLedWrite(BOARD_LED, 0, 0, 0);
  radio.startReceive();
  flushGps();
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

  gpsFix = fix;
  if (fix) {
    gpsLat = lat;
    gpsLon = lon;
    printScreen("GPS FIX", String(lat, 5), String(lon, 5));
  } else {
    printScreen("GPS", "No fix");
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

void sendPosition() {
  if (!gpsFix) {
    sendLoRaMessage("POS NOFIX");
    return;
  }
  String body = "POS " + String(gpsLat, 6) + " " + String(gpsLon, 6);
  sendLoRaMessage(body);
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
  printScreen("Follower", "Booting...", "Initializing RF");

  Serial.begin(115200);
  delay(300);
  Serial.println("FOLLOWER UP");
  Serial2.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("GPS UART is Serial2 RX GPIO 47 at 9600. NEO-6M TX goes there.");

  pinMode(FEM_POWER, OUTPUT);
  digitalWrite(FEM_POWER, HIGH);
  delay(10);
  pinMode(FEM_EN, OUTPUT);
  digitalWrite(FEM_EN, HIGH);
  pinMode(FEM_PA, OUTPUT);
  digitalWrite(FEM_PA, LOW);
  delay(10);

  pinMode(BTN_OK_PIN, INPUT_PULLUP);

  int state = radio.begin(915.0, 125.0, 9, 5, 0x12, 10, 8, 1.8);
  if (state == RADIOLIB_ERR_NONE) {
    Serial.println("SX1262 Init Success!");
    printScreen("Follower", "Ready", "Waiting GPS");
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
      rgbLedWrite(BOARD_LED, 0, 255, 0);
      digitalWrite(RX_LED_PIN, HIGH);
      printScreen("RECEIVED PACKET", str, "RSSI: " + String(rssi) + " dBm");
      rxLedOnTime = millis();
      rxLedActive = true;
      radio.startReceive();
      if (upper == "PING") sendPosition();
    } else {
      radio.startReceive();
    }
  }

  if (rxLedActive && (millis() - rxLedOnTime >= rxLedDuration)) {
    rgbLedWrite(BOARD_LED, 0, 0, 0);
    digitalWrite(RX_LED_PIN, LOW);
    rxLedActive = false;
  }

  if ((millis() - lastDebounceTime) > debounceDelay && digitalRead(BTN_OK_PIN) == LOW) {
    lastDebounceTime = millis();
    sendLoRaMessage("OK");
  }

  delay(10);
}
