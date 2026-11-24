// eslint-disable-next-line @typescript-eslint/no-require-imports -- The browser alias is a CommonJS module.
const util = require("next/dist/compiled/util/util.js");

// Meshtastic's logger calls Node's util.formatWithOptions. The browser
// util polyfill Next ships does not define it, so connecting throws.
function formatWithOptions(inspectOptions, ...args) {
  if (args.length === 0) return "";
  const first = args[0];
  if (typeof first === "string" && first.includes("%")) return util.format(...args);
  return args
    .map((arg) => (typeof arg === "string" ? arg : util.inspect(arg, inspectOptions)))
    .join(" ");
}

util.formatWithOptions = formatWithOptions;
module.exports = util;
