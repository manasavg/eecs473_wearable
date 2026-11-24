/**
 * Adjusts the iOS Bluetooth plugin for Meshtastic discovery and connections.
 *
 * A diff patch fails on a Mac: the plugin file uses Windows line endings, and
 * git turns the patch into Unix endings on checkout. This script edits the
 * file directly and keeps whichever line ending is already there.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(
  root,
  "node_modules/@capacitor-community/bluetooth-le/ios/Sources/BluetoothLe/DeviceManager.swift",
);

if (!existsSync(file)) {
  console.log("Bluetooth plugin is not installed yet. Skipping the iOS scan fix.");
  process.exit(0);
}

const original = readFileSync(file, "utf8");
const newline = original.includes("\r\n") ? "\r\n" : "\n";
let text = original.replaceAll("\r\n", "\n");

const applied =
  text.includes("let servicesToScan: [CBUUID]? = serviceUUIDs.isEmpty ? nil : serviceUUIDs") &&
  (text.includes("let resolvedName = peripheral.name ?? advertisedName") ||
    text.includes("let resolvedName = advertisedName ?? peripheral.name")) &&
  text.includes("self.stopScan()\n        self.centralManager.connect");

const nameFilter = `    private func passesNamePrefixFilter(peripheralName: String?) -> Bool {
        guard let prefix = self.deviceNamePrefixFilter else { return true }
        guard let name = peripheralName else { return false }
        return name.hasPrefix(prefix)
    }`;

if (!applied) {

const replacements = [
  [
    `            self.centralManager.scanForPeripherals(
                withServices: serviceUUIDs,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: allowDuplicates]
            )`,
    `            // An empty list must scan for every device. CoreBluetooth treats [] as
            // "match nothing", which hides a beacon that advertises by name.
            let servicesToScan: [CBUUID]? = serviceUUIDs.isEmpty ? nil : serviceUUIDs
            self.centralManager.scanForPeripherals(
                withServices: servicesToScan,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: allowDuplicates]
            )`,
  ],
  [
    `        guard self.passesNameFilter(peripheralName: peripheral.name) else { return }
        guard self.passesNamePrefixFilter(peripheralName: peripheral.name) else { return }`,
    `        // Use the advertised local name when CoreBluetooth has no cached name.
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let resolvedName = peripheral.name ?? advertisedName

        guard self.passesNameFilter(peripheralName: resolvedName) else { return }
        guard self.passesNamePrefixFilter(peripheralName: resolvedName) else { return }`,
  ],
  [
    `            log("New device found: ", peripheral.name ?? "Unknown")`,
    `            log("New device found: ", resolvedName ?? "Unknown")`,
  ],
  [
    `self?.alertController?.addAction(UIAlertAction(title: peripheral.name ?? "Unknown", style: UIAlertAction.Style.default, handler: { (_) in`,
    `self?.alertController?.addAction(UIAlertAction(title: resolvedName ?? "Unknown", style: UIAlertAction.Style.default, handler: { (_) in`,
  ],
  [
    `self?.deviceListView?.addItem(peripheral.name ?? "Unknown", action: {`,
    `self?.deviceListView?.addItem(resolvedName ?? "Unknown", action: {`,
  ],
  [
    `        log("Connecting to peripheral", device.getPeripheral())
        self.centralManager.connect(device.getPeripheral(), options: nil)`,
    `        log("Connecting to peripheral", device.getPeripheral())
        // iOS drops or stalls the link if a scan is still running.
        self.stopScan()
        self.centralManager.connect(device.getPeripheral(), options: nil)`,
  ],
];

for (const [from, to] of replacements) {
  if (!text.includes(from)) {
    console.error(
      "Could not update the Bluetooth plugin. Install @capacitor-community/bluetooth-le@8.3.0 and run this again.",
    );
    process.exit(1);
  }
  text = text.replace(from, to);
}

}

const nameFilterStrict = `    private func passesNamePrefixFilter(peripheralName: String?) -> Bool {
        guard let prefix = self.deviceNamePrefixFilter else { return true }
        // Unnamed peripherals do not match a requested name prefix.
        guard let name = peripheralName, !name.isEmpty else { return false }
        return name.hasPrefix(prefix)
    }`;

text = text.replace(nameFilter, nameFilterStrict);

// iOS caches the name from the last connection. The packet is the current name.
text = text.replaceAll(
  "let resolvedName = peripheral.name ?? advertisedName",
  "let resolvedName = advertisedName ?? peripheral.name",
);

// A board the phone already tried to connect stays "connected" in iOS after the
// Heltec has gone back to advertising. Scan was throwing those away, so a
// board that is on and advertising never appeared in Find devices.
const hideConnected = `        guard peripheral.state != CBPeripheralState.connected else {
            log("found connected device", peripheral.name ?? "Unknown")
            // make sure we do not touch connected devices
            return
        }

`;
if (text.includes(hideConnected)) {
  text = text.replace(hideConnected, "");
}

writeFileSync(file, newline === "\r\n" ? text.replaceAll("\n", "\r\n") : text);
console.log("Updated the iOS Bluetooth plugin for Meshtastic discovery.");
