# Excursion

Excursion connects over Bluetooth to a board running Meshtastic. That board acts as the leader. The app sends check-ins through it and shows follower replies and GPS positions when available.

The board firmware lives in the separate Meshtastic `firmware` project. Use the PlatformIO `WEARABLE` environment for the custom PCB.

## Run locally

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:4317> in a browser that supports Web Bluetooth.

## Run on iPhone

Run `npm run cap:sync` to build the app and copy it into the iOS project. Open `ios/App/App.xcodeproj` in Xcode, select your iPhone, and run the app. Tap **Find devices** and select the leader board.

## Tests

```bash
npm test
```
