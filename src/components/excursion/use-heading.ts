"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type OrientEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

export type CompassStatus = "off" | "on" | "unavailable" | "denied";

/**
 * Stretch goal from the proposal: phone magnetometer + the beacon's relative angle.
 * The big arrow stays phone-relative either way. This hook only places a north mark.
 */
export function usePhoneHeading() {
  const [heading, setHeading] = useState<number | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [status, setStatus] = useState<CompassStatus>("off");
  const listening = useRef(false);

  const onEvent = useCallback((event: Event) => {
    const orient = event as OrientEvent;
    if (
      typeof orient.webkitCompassHeading === "number" &&
      !Number.isNaN(orient.webkitCompassHeading)
    ) {
      setHeading(normalizeHeading(orient.webkitCompassHeading));
      setStatus("on");
      return;
    }
    const absolute = orient.absolute === true || event.type === "deviceorientationabsolute";
    if (absolute && orient.alpha != null && !Number.isNaN(orient.alpha)) {
      setHeading(normalizeHeading(360 - orient.alpha));
      setStatus("on");
      return;
    }
    setStatus((current) => (current === "on" ? current : "unavailable"));
  }, []);

  useEffect(() => {
    const ctor = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof ctor.requestPermission === "function") setNeedsGesture(true);
  }, []);

  useEffect(() => {
    return () => {
      window.removeEventListener("deviceorientationabsolute", onEvent, true);
      window.removeEventListener("deviceorientation", onEvent, true);
    };
  }, [onEvent]);

  const start = useCallback(async () => {
    const ctor = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof ctor.requestPermission === "function") {
      try {
        const result = await ctor.requestPermission();
        if (result !== "granted") {
          setStatus("denied");
          return;
        }
      } catch {
        setStatus("denied");
        return;
      }
    }
    if (listening.current) return;
    listening.current = true;
    window.addEventListener("deviceorientationabsolute", onEvent, true);
    window.addEventListener("deviceorientation", onEvent, true);
  }, [onEvent]);

  return { heading, needsGesture, status, start };
}

function normalizeHeading(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
