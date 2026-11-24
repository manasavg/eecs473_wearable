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
    let latestHeading: number | null = null;
    const onEvent = (event: Event) => {
      const sample = event as OrientationWithCompass;
      const next = headingFromOrientation({
        webkitCompassHeading: sample.webkitCompassHeading,
        alpha: sample.alpha,
        absolute: sample.absolute,
      });
      if (next != null) latestHeading = next;
    };
    window.addEventListener("deviceorientationabsolute", onEvent);
    window.addEventListener("deviceorientation", onEvent);
    const renderTimer = window.setInterval(() => setHeading(latestHeading), 200);
    stopRef.current = () => {
      window.clearInterval(renderTimer);
      window.removeEventListener("deviceorientationabsolute", onEvent);
      window.removeEventListener("deviceorientation", onEvent);
    };
  }, []);

  useEffect(() => {
    const requestPermission = (
      window.DeviceOrientationEvent as { requestPermission?: () => Promise<PermissionState> } | undefined
    )?.requestPermission;
    if (typeof requestPermission === "function") {
      setNeedsGesture(true);
      return () => stopRef.current?.();
    }
    listen();
    return () => stopRef.current?.();
  }, [listen]);

  const enable = useCallback(async () => {
    const requestPermission = (
      window.DeviceOrientationEvent as { requestPermission?: () => Promise<PermissionState> } | undefined
    )?.requestPermission;
    if (typeof requestPermission === "function") {
      try {
        const result = await requestPermission.call(window.DeviceOrientationEvent);
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
