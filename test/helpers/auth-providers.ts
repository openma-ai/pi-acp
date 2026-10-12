/** Test providers exercising pi's auth flows (api_key, oauth, prompts, notifies). */

import type { Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai";

/** Provider with a real api_key login that accepts only "good-key". */
export function keyableProvider(id = "keyable"): Provider {
  const base = fauxProvider({
    provider: id,
    models: [{ id: `${id}-1`, name: "Keyable One", input: ["text"], contextWindow: 10_000 }],
  }).provider;
  return {
    ...base,
    name: "Keyable",
    auth: {
      apiKey: {
        name: "Keyable API key",
        async login(interaction) {
          interaction.notify({ type: "progress", message: "checking" });
          const key = await interaction.prompt({ type: "secret", message: "Paste key" });
          if (key !== "good-key") throw new Error("bad key");
          return { type: "api_key", key };
        },
        async resolve({ credential }) {
          return credential?.key !== undefined ? { auth: { apiKey: credential.key } } : undefined;
        },
      },
    },
  };
}

/** Provider whose oauth login emits every notify type and every prompt type. */
export function flowProvider(id = "flow", loginLabel?: string): Provider {
  const base = fauxProvider({
    provider: id,
    models: [{ id: `${id}-1`, name: "Flow One", input: ["text"], contextWindow: 10_000 }],
  }).provider;
  return {
    ...base,
    name: "Flow",
    auth: {
      oauth: {
        name: "Flow account",
        loginLabel,
        isSubscription: true,
        async login(interaction) {
          interaction.notify({ type: "info", message: "docs", links: [{ url: "https://x/y" }] });
          interaction.notify({ type: "info", message: "plain" });
          interaction.notify({ type: "auth_url", url: "https://auth.example" });
          interaction.notify({
            type: "device_code",
            userCode: "ABCD-1234",
            verificationUri: "https://v.example",
          });
          interaction.notify({ type: "progress", message: "waiting" });
          await interaction.prompt({ type: "text", message: "name?" });
          await interaction.prompt({ type: "manual_code", message: "code?" });
          const pick = await interaction.prompt({
            type: "select",
            message: "pick",
            options: [
              { id: "a", label: "Alpha", description: "first" },
              { id: "b", label: "Beta" },
            ],
          });
          if (pick !== "b") throw new Error("must pick b");
          return { type: "oauth", refresh: "rt", access: "tok", expires: 0 };
        },
        async refresh() {
          throw new Error("not needed");
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
}
