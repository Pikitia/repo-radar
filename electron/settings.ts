import Store from "electron-store";
import { defaultSettings, type AppSettings } from "../src/types/settings.js";

let store: Store<AppSettings> | null = null;

function getStore(): Store<AppSettings> {
  store ??= new Store<AppSettings>({
    defaults: defaultSettings,
    name: "repo-radar-settings"
  });
  return store;
}

export function getSettings(): AppSettings {
  const store = getStore();
  return {
    ...defaultSettings,
    ...store.store,
    ai: {
      ...defaultSettings.ai,
      ...(store.store.ai ?? {})
    }
  };
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const next: AppSettings = {
    ...current,
    ...partial,
    ai: {
      ...current.ai,
      ...(partial.ai ?? {})
    }
  };
  getStore().set(next);
  return getSettings();
}
