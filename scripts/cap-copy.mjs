/**
 * Copies the built app into the Xcode project.
 *
 * `npx cap sync ios` also runs xcodebuild clean, which sits forever while
 * Xcode has this project open. The native plugins are already in the project,
 * so the phone only needs the new web files.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const publicDir = join(root, "ios/App/App/public");
const configPath = join(root, "ios/App/App/capacitor.config.json");

if (!existsSync(join(outDir, "index.html"))) {
  console.error("The built app is missing. Run git pull, then npm run cap:sync again.");
  process.exit(1);
}

console.log("Copying the app into the Xcode project.");
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
cpSync(outDir, publicDir, { recursive: true });
writeFileSync(join(publicDir, "cordova.js"), "");
writeFileSync(join(publicDir, "cordova_plugins.js"), "");

// Xcode bundles this file. Git ignores it as generated, so a fresh clone has none.
// This is the file Capacitor writes when no Cordova plugins are installed.
const cordovaConfigPath = join(root, "ios/App/App/config.xml");
if (!existsSync(cordovaConfigPath)) {
  writeFileSync(
    cordovaConfigPath,
    `<?xml version='1.0' encoding='utf-8'?>
<widget version="1.0.0" xmlns="http://www.w3.org/ns/widgets" xmlns:cdv="http://cordova.apache.org/ns/1.0">
  <access origin="*" />
</widget>
`,
  );
}

const config = JSON.parse(readFileSync(join(root, "capacitor.config.json"), "utf8"));
config.packageClassList = ["BluetoothLe", "LocalNotificationsPlugin"];
writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
console.log("Copied. Press Run in Xcode.");
