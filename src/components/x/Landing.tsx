"use client";

import { useEffect } from "react";
import { rememberLanding } from "@/lib/ops/funnel-client";

/** Mounted once in the root layout: notes where this visit came from, for the hire funnel. Renders nothing. */
export default function Landing() {
  useEffect(() => rememberLanding(), []);
  return null;
}
