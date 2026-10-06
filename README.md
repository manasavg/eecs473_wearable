# Excursion — leader app

Phone dashboard for the Guided Excursion Wearable (EECS 473). One leader beacon
clips to the back of the phone. Each hiker wears a wristband. This app shows
distance, direction, battery, and status, and it sends check-ins. UWB covers
about 40 m. LoRa check-ins cover about 1.5 km. The screen does not use a cell
network.

The radios are not required to run it. **Practice with a demo group** is a full
stand-in for the beacon until the ESP32 is advertising. The dashboard does not
change when you swap in the real link.

## Run it

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

```bash
npm test
npm run lint
```

## What the leader can do

- See every wristband: id, distance, bearing, battery, and status
  (OK, check-in pending, Need Help, out of range).
- See the beacon battery. The beacon has no LED for it.
- Tap once to check in one person, or everyone (`0xFF`).
- Watch a 60-second countdown while the wristband vibrates.
- Set the separation line from 5 m to 40 m.
- Get an alert when someone needs help, crosses the line, or loses UWB
  (10 missed pings). One blocked ping does not alert.
- Point the phone at the group. The arrow is relative to the phone.
  The compass button adds a north mark from the magnetometer (stretch goal).
- Rename wristbands on this phone only. Names are not sent to the beacon.

Night colors are for the trail after dark. Alert sound can be muted. The phone
still vibrates on an alert when the browser allows it.

## Where the Bluetooth code goes

Search the repo for `TODO(ble)`.

| File | What you change |
| --- | --- |
| `src/lib/ble/uuids.ts` | Advertised name and the five GATT UUIDs |
| `src/lib/ble/protocol.ts` | Byte codec. Flip `ANGLE_SIGN` if the BU04 angle runs the other way |
| `src/lib/ble/web-bluetooth-transport.ts` | Chooser, bonding, reconnect, notify-on-subscribe |
| `src/lib/ble/native-transport.todo.ts` | iPhone build. Safari has no Web Bluetooth |
| `src/lib/ble/create-transport.ts` | Switch that picks demo, Web Bluetooth, or native |
| `src/lib/ble/ranging.ts` | Demo copy of the missed-ping and separation rules |
| `PROTOCOL.md` | The contract to implement on the ESP32 |

Chrome on Android (and desktop Chrome) can connect as soon as the beacon
advertises. The Beacon link sheet can change the name prefix to match a module
that is already showing up on the phone, without editing code.

The packet layout, including a known test vector, is in `PROTOCOL.md`.
`npm test` locks that vector.

## Demo trail

Field test, after you open the demo group, stands in for hardware:

- Hold Sync assigns wristbands 1 and 2. Forget wristbands clears them.
- Distance steps, one missed UWB ping, and a full UWB loss.
- Trip separation alert. At a 40 m line this is the 10-ping loss, because UWB
  does not return a distance past its ceiling. Lower the line to see a fix
  that is still on the dial.
- 3-second press sends Need Help. The response button sends I'm OK.
- Drift walks the group a little every 2-second cycle.

## Stack

Next.js, TypeScript, Tailwind, shadcn/ui. State lives in `ExcursionAppClient`
(`src/lib/ble/app-client.ts`), which mirrors the `App` class in the proposal:
connect, parse, check-in, alert, update UI.
