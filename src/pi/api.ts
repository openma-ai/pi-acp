/**
 * The Pi SDK surface the adapter runs on.
 *
 * The bindings are filled in at startup from the Pi installation the user
 * chose (see `host.ts`). Every module reads the same loaded instance, so
 * sessions, extensions, and the credential store share one module identity
 * with that installation — the adapter never imports Pi for itself.
 */

import type { PiSource } from "./resolve.ts";

/** The Pi SDK module (`@earendil-works/pi-coding-agent`). */
export type PiApi = typeof import("@earendil-works/pi-coding-agent");

export interface PiInstallation {
  /** Version of the loaded Pi installation (from its `package.json`). */
  version: string;
  /** Directory of the loaded `@earendil-works/pi-coding-agent` package. */
  packageDir: string;
  /** How the installation was found. */
  source: PiSource;
  /** How the installation was found (a path, a project directory, an executable). */
  detail: string;
}

/** The loaded Pi SDK. Empty until `installPiSdk` runs at startup. */
export const piSdk = {} as PiApi;

const state: { installation?: PiInstallation } = {};

/** Install the Pi SDK loaded from the user's installation. */
export function installPiSdk(api: PiApi, installation: PiInstallation): void {
  Object.assign(piSdk, api);
  state.installation = installation;
}

/** The loaded Pi installation. Throws when the adapter started without one. */
export function piInstallation(): PiInstallation {
  const found = state.installation;
  if (found === undefined) throw new Error("the Pi SDK is not loaded");
  return found;
}
