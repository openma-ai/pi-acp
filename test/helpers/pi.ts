/**
 * Load the Pi SDK the adapter runs on, the way the bin does.
 *
 * In this repository the Pi installation is the dev dependency in
 * `node_modules`, and the repository manifest declares it — so the project
 * candidate of the resolution picks it up, exactly like a user install.
 */

import { loadPiHost } from "../../src/pi/host.ts";

let pending: Promise<void> | undefined;

/** Load the Pi SDK once per process. */
export function ensurePiSdk(): Promise<void> {
  pending ??= loadPiHost({ cwd: process.cwd() }).then(
    () => undefined,
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  );
  return pending;
}
