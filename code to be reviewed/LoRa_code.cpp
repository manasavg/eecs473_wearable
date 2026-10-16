// Heltec Wifi LoRa V4
// Tools: USB CDC on Boot Enabled, Upload Mode USB-OTG CDC TinyUSB
#include <RadioLib.h>
#include <U8x8lib.h>
#include <Wire.h>
#include <Preferences.h>

Preferences prefs;
String myId = "N01";
uint16_t seqNum = 0;

// Heltec V4 Pin Mapping
#define OLED_SDA 17
#define OLED_SCL 18
#define OLED_RST 21
#define VEXT_CTRL 36 // Pull LOW for power rail

#define LORA_NSS 8
#define LORA_DIO1 14
#define LORA_RST 12
#define LORA_BUSY 13

#define FEM_EN 2
#define FEM_PA 5
#define BOARD_LED 38 // V4 Onboard RGB LED (GPIO38)

#define FEM_POWER 7

// External Button Pins (Safe GPIOs)
#define BTN_CHECKIN_PIN 4 // Button 1: Sends "CHECK IN"
#define BTN_OK_PIN 6      // Button 2: Sends "OK"

// Debounce timing
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 250; // ms

// Screen Initialization (U8x8 Non-blocking driver)
U8X8_SSD1306_128X64_NONAME_SW_I2C u8x8(OLED_SCL, OLED_SDA, OLED_RST);
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);

struct Packet
{
  String src, dst, seq, type, payload;
  bool valid;
};

Packet parsePacket(const String &s)
{
  Packet p;
  p.valid = false;
  int idx[4], start = 0;
  for (int i = 0; i < 4; i++)
  {
    idx[i] = s.indexOf('|', start);
    if (idx[i] < 0)
      return p;
    start = idx[i] + 1;
  }
  p.src = s.substring(0, idx[0]);
  p.dst = s.substring(idx[0] + 1, idx[1]);
  p.seq = s.substring(idx[1] + 1, idx[2]);
  p.type = s.substring(idx[2] + 1, idx[3]);
  p.payload = s.substring(idx[3] + 1);
  p.valid = true;
  return p;
}

void printScreen(String line1, String line2, String line3 = "")
{
  u8x8.clearDisplay();
  u8x8.setCursor(0, 0);
  u8x8.print(line1);
  u8x8.setCursor(0, 2);
  u8x8.print(line2);
  if (line3.length() > 0)
  {
    u8x8.setCursor(0, 4);
    u8x8.print(line3);
  }
}

// Helper function to transmit LoRa packet
void sendPacket(String dst, String type, String payload) // changed this from sendLoRaMessage
{
  String pkt = myId + "|" + dst + "|" + String(seqNum++) + "|" + type + "|" + payload;

  neopixelWrite(BOARD_LED, 0, 0, 255);
  printScreen("TX -> " + dst, payload);

  digitalWrite(FEM_PA, HIGH);
  int txState = radio.transmit(pkt);
  digitalWrite(FEM_PA, LOW);

  Serial.println("[TX] " + pkt + (txState == RADIOLIB_ERR_NONE ? " OK" : " FAIL " + String(txState)));
  neopixelWrite(BOARD_LED, 0, 0, 0);
  radio.startReceive();
}

void setup()
{
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
  delay(500);
  Serial.println("\n--- HELTEC V4 LORA NODE STARTUP ---");

  // 4.1. ID CHECK
  prefs.begin("lora", false);
  myId = prefs.getString("id", "N01");
  Serial.println("My ID: " + myId);

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

  if (state == RADIOLIB_ERR_NONE)
  {
    Serial.println("SX1262 Init Success!");
    printScreen("Heltec V4 Node", "Ready to Send", "Press a Button");
  }
  else
  {
    Serial.print("SX1262 Init Failed, Code: ");
    Serial.println(state);
    printScreen("ERROR!", "Radio Failed", "Code: " + String(state));
    while (true)
      ;
  }

  radio.setDio2AsRfSwitch(true);
  radio.startReceive();
}

void loop()
{
  // 1. RECEIVE INCOMING LORA MESSAGES
  if (digitalRead(LORA_DIO1) == HIGH)
  {
    String str;
    int radioState = radio.readData(str);

    if (radioState == RADIOLIB_ERR_NONE && str.length() > 0)
    {
      Packet p = parsePacket(str);
      if (p.valid && p.src != myId && (p.dst == myId || p.dst == "ALL"))
      {
        int rssi = radio.getRSSI();
        Serial.println("[RX] " + str + " | RSSI " + String(rssi));
        printScreen("From " + p.src, p.payload, "RSSI: " + String(rssi));
        neopixelWrite(BOARD_LED, 0, 255, 0);
        delay(150);
        neopixelWrite(BOARD_LED, 0, 0, 0);

        // Auto-ACK direct messages (never ACK an ACK or a broadcast)
        if (p.dst == myId && p.type != "ACK")
        {
          delay(50);
          sendPacket(p.src, "ACK", p.seq);
        }
      }
    }
    radio.startReceive();
  }

  // 2. CHECK BUTTON PRESSES
  if ((millis() - lastDebounceTime) > debounceDelay)
  {
    if (digitalRead(BTN_CHECKIN_PIN) == LOW)
    {
      lastDebounceTime = millis();
      sendPacket("ALL", "CHK", "CHECK IN");
    }
    else if (digitalRead(BTN_OK_PIN) == LOW)
    {
      lastDebounceTime = millis();
      sendPacket("ALL", "OK", "OK");
    }
  }

  // 3. SERIAL INPUT
  if (Serial.available() > 0)
  {
    String outgoingMsg = Serial.readStringUntil('\n');
    outgoingMsg.trim();

    if (outgoingMsg.length() > 0)
    {
      if (outgoingMsg.startsWith("/id "))
      {
        myId = outgoingMsg.substring(4);
        myId.trim();
        prefs.putString("id", myId);
        Serial.println("ID set to " + myId);
      }
      else if (outgoingMsg.startsWith("/to "))
      {
        int sp = outgoingMsg.indexOf(' ', 4);
        if (sp > 0)
          sendPacket(outgoingMsg.substring(4, sp), "MSG", outgoingMsg.substring(sp + 1));
        else
          Serial.println("Usage: /to N02 your message");
      }
      else
      {
        sendPacket("ALL", "MSG", outgoingMsg);
      }
    }
  }

  delay(10);
}