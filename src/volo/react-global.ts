// The vendored Spectrum 2 bundle (vendor/ds_bundle.js) is a pre-compiled
// browser script that references a bare global `React` (verified: 0 ReactDOM
// references in the bundle). Expose React on the global object before the
// bundle runs so those references resolve.
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
