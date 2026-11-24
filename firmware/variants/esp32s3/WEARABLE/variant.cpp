#include "Arduino.h"
#include "variant.h"

extern "C" {
void initVariant() {
    // Enable internal pull-ups for buttons wired to GND without external resistors
    pinMode(BUTTON_PIN_ALT, INPUT_PULLUP);   // GPIO 4
    pinMode(BUTTON_PIN_TOUCH, INPUT_PULLUP); // GPIO 5
}
}