/**
 * DW1000 ranging - ANCHOR
 * Channel 2, range filter, outlier rejection, rolling average printed every 2 s.
 * Flash the matching tag sketch on the other board (same mode and channel).
 *
 * Arduino Uno. Sends the filtered average to the Heltec (ESP32) over SoftwareSerial:
 *   Uno pin 9 TX -> Heltec GPIO 47 RX
 *   GND -> GND
 * 9600 baud. Line format: DIST 12.34
 * Select "Arduino Uno" in the IDE. The tag sketch is unchanged.
 */
#include <SPI.h>
#include <SoftwareSerial.h>
#include "DW1000Ranging.h"

// connection pins
const uint8_t PIN_RST = 7; // reset pin
const uint8_t PIN_IRQ = 2; // irq pin
const uint8_t PIN_SS = SS; // spi select pin

// Pin 9 is free next to the DW1000 shield (IRQ is 2, RST is 7, SS is 10).
const int DIST_RX_PIN = 8; // unused, leave open
const int DIST_TX_PIN = 9; // wire to Heltec GPIO 47
SoftwareSerial DistSerial(DIST_RX_PIN, DIST_TX_PIN);

// ---- tuning ----
const float RANGE_CORRECTION = 0.0;      // meters added to every reading (fixed offset fix)
const float MIN_VALID_M = -5.0;           // readings below this are discarded
const float MAX_VALID_M = 100.0;         // readings above this are discarded
const float OUTLIER_M = 1.0;             // discard readings this far from the window median
const uint8_t WINDOW = 10;               // rolling average size (samples)
const uint8_t MIN_FOR_MEDIAN = 5;        // samples needed before outlier test starts
const uint8_t RESEED_AFTER = 5;          // after this many rejects in a row, accept the new value
const unsigned long PRINT_MS = 2000;     // print interval

float buf[WINDOW];
uint8_t count = 0, head = 0, consecutiveRejects = 0;
uint16_t acceptedSincePrint = 0, rejectedSincePrint = 0, rxN = 0;
float rxSum = 0;
unsigned long lastPrint = 0;

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("ANCHOR UP"));
  DistSerial.begin(9600);
  delay(1000);
  DW1000Ranging.initCommunication(PIN_RST, PIN_SS, PIN_IRQ); //Reset, CS, IRQ pin

  DW1000Ranging.attachNewRange(newRange);
  DW1000Ranging.attachBlinkDevice(newBlink);
  DW1000Ranging.attachInactiveDevice(inactiveDevice);

  DW1000Ranging.setResetPeriod(1000);   // delete this line if it won't compile (not in every fork)
  DW1000Ranging.useRangeFilter(true);

  DW1000Ranging.startAsAnchor("82:17:5B:D5:A9:9A:E2:9C", DW1000.MODE_LONGDATA_RANGE_ACCURACY);
  DW1000.setAntennaDelay(16384-180);
  // channel 2 - must match the tag. Remove these 3 lines (on both boards) to test without it.
  DW1000.newConfiguration();
  DW1000.setChannel(DW1000.CHANNEL_2);
  DW1000.commitConfiguration();
}

void loop() {
  DW1000Ranging.loop();
  if (millis() - lastPrint >= PRINT_MS) {
    lastPrint = millis();
    report();
  }
}

void push(float r) {
  buf[head] = r;
  head = (head + 1) % WINDOW;
  if (count < WINDOW) count++;
}

float median() {
  float tmp[WINDOW];
  for (uint8_t i = 0; i < count; i++) tmp[i] = buf[i];
  for (uint8_t i = 1; i < count; i++) {
    float k = tmp[i];
    int8_t j = i - 1;
    while (j >= 0 && tmp[j] > k) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = k;
  }
  if (count & 1) return tmp[count / 2];
  return (tmp[count / 2 - 1] + tmp[count / 2]) / 2.0;
}

void addSample(float r) {
  if (r < MIN_VALID_M || r > MAX_VALID_M) { rejectedSincePrint++; return; }
  if (count >= MIN_FOR_MEDIAN && fabs(r - median()) > OUTLIER_M) {
    rejectedSincePrint++;
    if (++consecutiveRejects >= RESEED_AFTER) {   // real movement, not noise: restart the window
      count = 0; head = 0; consecutiveRejects = 0;
      push(r); acceptedSincePrint++;
    }
    return;
  }
  consecutiveRejects = 0;
  push(r);
  acceptedSincePrint++;
}

void report() {
  Serial.print(F("t=")); Serial.print(millis() / 1000); Serial.print(F("s  "));
  if (acceptedSincePrint == 0) {
    Serial.print(F("no valid readings, rejected="));
    Serial.println(rejectedSincePrint);
  } else {
    float sum = 0;
    for (uint8_t i = 0; i < count; i++) sum += buf[i];
    float avg = sum / count;
    Serial.print(F("avg=")); Serial.print(avg, 2);
    Serial.print(F(" m  rx="));
    if (rxN) Serial.print(rxSum / rxN, 1); else Serial.print(F("n/a"));
    Serial.print(F(" dBm  ok=")); Serial.print(acceptedSincePrint);
    Serial.print(F(" rej=")); Serial.println(rejectedSincePrint);
    DistSerial.print(F("DIST "));
    DistSerial.println(avg, 2);
    Serial.print(F("pin9 DIST "));
    Serial.println(avg, 2);
  }
  acceptedSincePrint = 0; rejectedSincePrint = 0; rxSum = 0; rxN = 0;
}

void newRange() {
  DW1000Device* d = DW1000Ranging.getDistantDevice();
  addSample(d->getRange() + RANGE_CORRECTION);
  rxSum += d->getRXPower();
  rxN++;
}

void newBlink(DW1000Device* device) {
  Serial.print(F("blink; 1 device added ! -> short:"));
  Serial.println(device->getShortAddress(), HEX);
}

void inactiveDevice(DW1000Device* device) {
  Serial.print(F("delete inactive device: "));
  Serial.println(device->getShortAddress(), HEX);
}
