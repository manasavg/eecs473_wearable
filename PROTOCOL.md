# Radios

Every Heltec board runs stock Meshtastic firmware from https://flasher.meshtastic.org/. Every board needs the same region and channel. The phone talks only to the board it is connected to, which makes that board the leader. Every other board is a follower. To swap the leader, disconnect and tap a different board.

The app works with any number of boards: one leader and one follower is the minimum, and the planned design is one leader and four followers. Nothing in the app is tied to a board count.

The phone uses Meshtastic's own client (`@meshtastic/core`). `src/lib/meshtastic/link.ts` passes that client's events to the dashboard.

## Bluetooth

This is the Meshtastic Phone API.

| | |
| --- | --- |
| Name | Starts with `Meshtastic` |
| Service | `6ba1b218-15a8-461f-9fa8-5dcae273eafd` |
| ToRadio write | `f75c76d2-129e-4dad-a1dd-7866124401e7` |
| FromRadio read | `2c55e69e-4993-11ed-b878-0242ac120002` |
| FromNum notify | `ed9da18c-a800-4f66-a670-aa7547e34453` |

The phone scans for the name prefix, shows each board, and connects to the one you tap.

Each ToRadio write is one `ToRadio` protobuf. FromNum notifies a 4-byte counter when the radio has something queued. The phone then reads FromRadio repeatedly, one `FromRadio` protobuf per read, until a read comes back empty.

Once connected, the phone sends `want_config`. The radio answers with its own node info and its node database.

## Nodes

`MyNodeInfo` tells the phone which node number belongs to the leader. That node's position is the leader's own GPS fix.

Every other node in the database is shown as a follower card, named by its long name, then its short name, then `Meshtastic` plus the last four hex digits of its node number. A node is left out when it is:

- heard over MQTT,
- ignored on the radio,
- more than 2 hops away, or
- not heard for 6 hours.

A board appears as soon as the leader hears any packet from it, even before it has a GPS fix or has sent its name. Until its name arrives it is called `Meshtastic` plus the last four hex digits of its node number. A board left out as not heard for 6 hours comes back as soon as it is heard again.

Use a private channel with its own key. On a shared or default channel, any stranger's board within 2 hops shows up too.

## Group

The group is the list of your team's boards, saved on the phone. Include every board, the leader too, so any board can lead.

- On the iPhone, the board list on the connect screen has a checkbox on each board. Tick your team's boards, then tap **Make leader** on one. Boards in the group that the scan did not find still show, so they can be unticked. Making a board leader adds it to the group when a group exists.
- Bluetooth shows only the last 4 hex digits of a board's node number (`Meshtastic_a688`), so members are matched by those digits. Two of your own boards would need the same 4 digits to clash.
- With no group, every board heard is a follower. **Make these boards the group** adds the leader and every board shown.
- With a group, only members are followers. Other boards heard go under **Other boards nearby**, with an **Add to group** button. They get no alerts and no check-ins.
- A member not heard yet still has a card that says not heard yet, with no Check in button. After the lost-contact time it is flagged as lost, so a board that never shows up is not missed.
- **Remove** on a card takes that board out of the group.
- The connected board is never listed as a follower. If it is not in the group, the app offers to add it.

### When the phone sees a board but the leader does not

The phone finds boards over Bluetooth, which works whatever the radios are set to. Followers come over LoRa, so a board the phone can see but the leader never lists cannot be heard over the radio. Check, in this order:

1. Each board has been set up with the current Board setup, so it sends its battery report every 60 s. Without a GPS fix, a board that has not been set up sends almost nothing, so the leader may not hear it for many minutes.
1. The region is set. The dashboard warns when the connected board's region is not set.
2. Every board has the same region, preset, and channel. Board setup sets all three, and lists any difference on the connected board.
3. Both boards have antennas attached. If one board hears the other but not the reverse, check the antenna on the board that is not heard, since its transmit path is the one failing.

A board stops advertising over Bluetooth while anything is connected to it, such as the Meshtastic app running in the background. The board list also shows boards this phone is already connected to, but a board connected to another phone does not appear until that phone lets go.

Settings are sent with the current `@meshtastic/protobufs` definitions, not the older copy bundled in `@meshtastic/core`, which drops newer fields such as the one that turns battery reports on.

## Lost contact

The app records when the leader last heard anything from each follower. A follower silent for longer than the lost-contact limit is flagged on its card and in the alert banner, and the phone sends a notification. Its distance is then shown as a last known value. The limit is 120 s by default, adjustable from 30 to 3600 s, and saved on the phone.

A board that the radio's database lists but never timed counts its silence from when the phone connected.

## Last known location

The phone keeps each follower's newest valid GPS fix and the time it was taken: the board's GPS time when the radio has one, otherwise when the phone received it. A lost fix or a silent board does not erase it, and an older fix never replaces a newer one.

When a follower is out of range, has lost contact, or has no fix, its card shows that last known location with the clock time and how long ago it was taken. It also shows the distance and direction from the leader's current fix, plus an Open in Maps link. The alert banner and the lost-contact notification include the same location and time.

The phone saves these locations, so they survive a reconnect or an app restart. Locations older than 7 days are dropped.

## GPS

The Meshtastic firmware reads the GPS. Wire the NEO-6M to the Heltec V4 GPS port: GPIO 38 toward the GPS module, GPIO 39 toward the board, 9600 baud, VCC to 5V, GND to GND. The antennas need a view of the sky.

Positions arrive as `Position` packets and in the node database. `latitude_i` and `longitude_i` are degrees × 10⁷. A missing value, `0, 0`, or a value outside ±90 / ±180 counts as No fix.

## Range

The phone computes the distance and direction from the leader's fix to each follower. The range limit lives only on the phone: 40 m by default, adjustable from 1 to 2000 m, and saved on the phone. The radio is not told the limit. A follower beyond the limit is marked out of range, and the phone sends a local notification.

When either the leader or a follower reports no fix, that follower's distance shows No fix and it is not counted as out of range.

The red LED on a far board is not part of stock Meshtastic, so it does not light.

## Check-in

Each follower card has its own Check in button. Check in all sends one to every follower. Each is a direct Meshtastic text `CHECK IN` with an acknowledgement requested, and each card tracks its own answer.

| Card shows | Meaning |
| --- | --- |
| Sending | The phone is writing it to the leader |
| Waiting | The leader queued it, with this packet id |
| Received | That follower's own radio acknowledged this packet id. Nobody has pressed OK yet. |
| OK · pressed | Someone pressed the OK button on that board |
| No OK pressed | The board received it, but nobody pressed OK within 120 s |
| No answer | The radio gave up retrying, or 120 s passed with no acknowledgement |
| Not delivered | The radio refused it, for example no route or over the airtime limit |

An acknowledgement from the leader itself does not count. That only means another radio repeated the message.

A press is a Detection Sensor message from that board, which is what the button below sends, whatever the module is named. The module sends it as its own message type, not as a text message. A text with the word `OK` in it also counts. Each card shows the last message its board sent, so you can see what a press actually sends. It counts only while that board has a check-in open, and a late press still turns the card OK. Presses with no open check-in are ignored.

The phone sends a notification when a check-in ends as No OK pressed, No answer, or Not delivered.

### Not requiring a press

The Alerts section has a setting, **Check-in needs an OK button press on the board**, on by default and saved on the phone. Turn it off for boards without a button. Then the radio's acknowledgement alone shows OK · received, which means the board got the message, not that a person saw it.

### The OK button

Stock Meshtastic can send a text when a pin changes, through its **Detection Sensor** module. Wire a push button from a free GPIO to GND on each follower. Then enter that GPIO in Excursion's Board setup, or set this in the Meshtastic app under **Module configuration → Detection Sensor**:

| Setting | Value |
| --- | --- |
| Enabled | On |
| Monitor pin | The GPIO the button is wired to |
| Friendly name | `OK`, so the message is `OK detected` |
| Trigger type | Either edge, active low, so the board reports the press and the release |
| Use pull-up | On |
| Minimum broadcast interval | 1 s, so the release of a 3 s hold is not held back |
| State broadcast interval | 0 (off), so the board never sends `OK` without a press |

Do not use a pin the board already uses. Board setup refuses the ones it knows: GPIO 0 (PRG button), 1, 3, 8–14 (LoRa radio), 17, 18, 21 (screen), 19, 20 (USB), 26–37 (flash, PSRAM, LED, power), 38, 39 (GPS), 45, 46. Pins likely free on the header: 2, 4, 5, 6, 7, 40, 41, 42, 47, 48.

If a press does nothing:

1. Set up the follower itself with the pin. Board setup changes only the board the phone is connected to. Connected to the follower, Board setup should not list "OK button is off".
2. Power the follower off and on, so the module starts watching the pin.
3. Check that the button joins the pin to GND when pressed. With a meter, the pin reads about 3.3 V released and 0 V pressed.
4. Send a check-in, press, and look for a "Last message" line on that board's card. If it is there but the card stays Received, the message has no "OK" in it; tell us what it says. Check the Heltec V4 pinout for a free pin. Setting names can vary slightly between firmware versions. Test one press with the Meshtastic app open on the leader before relying on it: an `OK detected` message should appear.

The module sends the text to the whole channel, which is another reason to use a private channel.

## Emergency

Holding a follower's OK button for 3 seconds raises an emergency. Stock Meshtastic does not time button presses, so the app does: Board setup sets the Detection Sensor to report both edges, and the app measures the time from the press message to the release message.

| Hold | Result |
| --- | --- |
| Under 3 s | A normal OK press |
| 3 s or more | Emergency |
| Press, then no release heard within 8 s | Emergency, but only for a board already seen sending a release |

The last rule covers a release lost on the radio. It applies only to boards that have sent a release before, so a board set up the old way, which reports only presses, never raises an emergency by mistake.

A text that starts with SOS, EMERGENCY or HELP also raises one.

An emergency shows as a red banner at the top with the board's name, the time, and its last known location with an Open in Maps link. Its card turns red and the phone sends a notification. It stays, across reconnects, until someone taps Acknowledge. Emergencies from boards outside the group are ignored.

To check a board reports releases: connected to the leader, hold the follower's button and let go. The card's Last message should change to something like `OK state: 0` after the release. If it only ever shows the press, run Board setup on that follower again and restart it.

## Board settings

The quickest way is **Board setup** in Excursion, below. The Meshtastic app works too. Every board needs these:

| Setting | Why |
| --- | --- |
| Private channel, same on every board | Keeps strangers' boards out of the follower list |
| Position broadcast interval, shorter than the lost-contact limit | Otherwise a healthy board is flagged between reports. The default is minutes. |
| Smart position: off, or minimum distance well below the range limit | Otherwise a board may not report until it moves farther than the limit |
| Channel position precision: full | Reduced precision rounds positions to hundreds of meters or more |

### Board setup in Excursion

The Board setup section on the dashboard writes the settings above to the connected board in one step. It can only change the board the phone is connected to, so connect to each board in turn, including the leader, and tap **Set up this board**.

| Field | Written to the board |
| --- | --- |
| Region | LoRa region, US by default. A freshly flashed board has none, and its radio stays off until one is set. |
| (fixed) | LongFast preset, Meshtastic's default, and transmit on. The other radio settings stay as they were. |
| Team channel name | Primary channel name (up to 11 characters) |
| Team key | Primary channel key (AES-256). The first time, the app generates one. |
| Position every | Position broadcast interval, 15–3600 s, default 30 s. Smart position off. GPS read every 15 s. |
| (fixed) | Battery report over the radio every 60 s. It goes out with or without a GPS fix, so it is the heartbeat that keeps a board from looking lost indoors, and it shows as Battery on the card. |
| OK button GPIO | Detection Sensor module, set up as in the OK button section. Blank leaves the module as it is. |

It also sets full position precision and turns off MQTT uplink and downlink on the channel. Each write starts from the board's current settings, so the GPS pins, GPS mode and everything else not listed stay as they were. If GPS was disabled, it is turned on.

The section compares the connected board with the team setup and lists what differs, so you can check each board after setup.

The app saves the team setup on the phone. To set up boards from another phone, copy the team key and paste it there with the same channel name. Anyone with the key can join the channel. Making a new key means every board has to be set up again.

Until every board is set up, boards still on the old channel do not hear the ones already moved. The board may restart to apply the settings, and the app reconnects.

Reading the GPS every 15 s uses more battery than Meshtastic's default of 120 s.

## Phone in the background

The iPhone app declares Bluetooth background use, so iOS keeps the link to the leader while the phone is locked. iOS may still pause the app's code in the background, so alerts there are not guaranteed. Test this on the phone before relying on it.

## LoRa

Meshtastic sets the LoRa radio from the region and modem preset chosen on each board. The app does not set it.

## Previous firmware

`firmware/excursion_device/excursion_device.ino` was an earlier custom sketch. It used `Excursion_XX` Bluetooth names, its own service, and raw LoRa messages (`FIND`, `HERE`, `PING`, `OK`) at 915 MHz. The app no longer speaks that protocol. Flashing Meshtastic replaces the sketch on the chip.
