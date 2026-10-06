# Excursion — leader app

Phone dashboard for the Guided Excursion Wearable (EECS 473). One leader beacon
clips to the back of the phone. Each hiker wears a wristband. This app shows
distance, direction, battery, and status, and it sends check-ins. UWB covers
about 40 m. LoRa check-ins cover about 1.5 km. The screen does not use a cell
network.

The radios are not required to practice. **Practice with a demo group** stands in
for wristbands. **Connect the beacon** opens the ESP32 sketch already running:
it advertises `Leader_Device` and notifies a counter every half second.

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
| `firmware/leader_device/leader_device.ino` | The sketch already on the ESP32. Name `Leader_Device`, one service, one characteristic |
| `src/lib/ble/uuids.ts` | Those UUIDs, plus the wristband characteristics to add later |
| `src/lib/ble/live-link.ts` | Counter and the setup string. Also accepts a 9-byte follower on that characteristic |
| `src/lib/ble/protocol.ts` | Wristband byte codec. Flip `ANGLE_SIGN` if the BU04 angle runs the other way |
| `src/lib/ble/web-bluetooth-transport.ts` | Chooser, notify, reconnect. Subscribes to extra characteristics only if they exist |
| `src/lib/ble/native-transport.todo.ts` | iPhone build. Safari has no Web Bluetooth |
| `src/lib/ble/create-transport.ts` | Switch that picks demo, Web Bluetooth, or native |
| `src/lib/ble/ranging.ts` | Demo copy of the missed-ping and separation rules |
| `PROTOCOL.md` | The contract to implement on the ESP32 |

Chrome on Android (and desktop Chrome) connects to `Leader_Device`. The Beacon
link sheet can change the name prefix if a module advertises something else.

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
