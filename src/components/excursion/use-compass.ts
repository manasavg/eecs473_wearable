"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { headingFromOrientation } from "@/lib/geo";

type OrientationWithCompass = DeviceOrientationEvent & { webkitCompassHeading?: number };

export function useCompass() {
  const [heading, setHeading] = useState<number | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [denied, setDenied] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const listen = useCallback(() => {
    stopRef.current?.();
    const onEvent = (event: Event) => {
      const sample = event as OrientationWithCompass;
      const next = headingFromOrientation({
        webkitCompassHeading: sample.webkitCompassHeading,
        alpha: sample.alpha,
        absolute: sample.absolute,
      });
      if (next != null) setHeading(next);
    };
    window.addEventListener("deviceorientationabsolute", onEvent);
    window.addEventListener("deviceorientation", onEvent);
    stopRef.current = () => {
      window.removeEventListener("deviceorientationabsolute", onEvent);
      window.removeEventListener("deviceorientation", onEvent);
    };
  }, []);

  useEffect(() => {
    const requestPermission = (
      DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<PermissionState> }
    ).requestPermission;
    if (typeof requestPermission === "function") {
      setNeedsGesture(true);
      return () => stopRef.current?.();
    }
    listen();
    return () => stopRef.current?.();
  }, [listen]);

  const enable = useCallback(async () => {
    const requestPermission = (
      DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<PermissionState> }
    ).requestPermission;
    if (typeof requestPermission === "function") {
      try {
        const result = await requestPermission();
        if (result !== "granted") {
          setDenied(true);
          return;
        }
      } catch {
        setDenied(true);
        return;
      }
    }
    setDenied(false);
    setNeedsGesture(false);
    listen();
  }, [listen]);

  return { heading, needsGesture, denied, enable };
}
