import type { BoardPlan, BoardSettings } from "../meshtastic/setup";
import { createTransport } from "./create-transport";
import { NativeBleTransport } from "./native-transport";
import type { BlePeer } from "./transport";

/** How long to wait for the board to report its settings after connecting. */
const READ_TIMEOUT_MS = 20_000;

/**
 * Set up a board without making it the leader. The phone opens a second, short Bluetooth
 * connection to it, writes the plan, and lets go; the link to the leader stays up.
 * `peer` is a board from the scan. Without one (outside the iPhone app) the browser asks.
 */
export async function setUpOtherBoard(
  peer: BlePeer | null,
  plan: BoardPlan,
  onProgress: (message: string) => void,
): Promise<"confirmed" | "restarting"> {
  const transport = createTransport("beacon");
  if (transport instanceof NativeBleTransport) transport.remembers = false;
  if (!transport.setUpBoard) throw new Error("This phone cannot change board settings.");

  let settings: BoardSettings | null = null;
  const unsubscribe = transport.subscribe((event) => {
    if (event.type === "board-settings") settings = event.settings;
  });
  try {
    onProgress("Connecting…");
    await transport.connect(false, peer ?? undefined);
    onProgress("Reading its settings…");
    const started = Date.now();
    while (!ready(settings)) {
      if (Date.now() - started > READ_TIMEOUT_MS) {
        throw new Error("Connected, but the board did not send its settings. Try again closer to it.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    onProgress("Writing the team settings…");
    return await transport.setUpBoard(plan);
  } finally {
    unsubscribe();
    await transport.disconnect().catch(() => undefined);
  }
}

function ready(settings: BoardSettings | null): boolean {
  return settings != null && settings.positionSecs != null && settings.region != null;
}
