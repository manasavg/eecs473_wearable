/**
 * Adjusts the iOS Bluetooth plugin so Leader_Device can be found and connected.
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
  text.includes("let resolvedName = peripheral.name ?? advertisedName") &&
  text.includes("self.stopScan()\n        self.centralManager.connect");

const nameFilter = `    private func passesNamePrefixFilter(peripheralName: String?) -> Bool {
        guard let prefix = self.deviceNamePrefixFilter else { return true }
        guard let name = peripheralName else { return false }
        return name.hasPrefix(prefix)
    }`;

const nameFilterFixed = `    private func passesNamePrefixFilter(peripheralName: String?) -> Bool {
        guard let prefix = self.deviceNamePrefixFilter else { return true }
        // iOS often omits the name. Dropping those devices hides Leader_Device.
        guard let name = peripheralName else { return true }
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
    `        // iOS often leaves peripheral.name nil until after bonding. The sketch
        // puts "Leader_Device" in the advertising packet as the local name.
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

if (text.includes(nameFilter)) {
  text = text.replace(nameFilter, nameFilterFixed);
}

text = text.replaceAll('resolvedName ?? "Unknown"', 'resolvedName ?? "Leader_Device_LoRa"');
text = text.replaceAll('resolvedName ?? "Leader_Device"', 'resolvedName ?? "Leader_Device_LoRa"');

writeFileSync(file, newline === "\r\n" ? text.replaceAll("\n", "\r\n") : text);
console.log("Updated the iOS Bluetooth plugin so it can find Leader_Device_LoRa.");
