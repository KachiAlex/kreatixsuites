import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.kreatixtech.suites",
  appName: "Kreatix Suites",
  webDir: "dist",
  // HTTPS scheme keeps fetch()/WS URLs same-origin-looking and matches
  // what the app expects; API calls go to suites.kreatixtech.com (see
  // src/lib/platform.ts — isNativeMobile sets API_BASE).
  android: {
    allowMixedContent: false,
    // Android 15 forces edge-to-edge — inset the WebView below the status/
    // gesture bars so top toolbars and the bottom rail stay reachable
    adjustMarginsForEdgeToEdge: "auto",
  },
};

export default config;
