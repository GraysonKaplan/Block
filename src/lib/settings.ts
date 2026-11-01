import { browser } from 'wxt/browser';
import { stringList } from './records';

export const SETTINGS_KEY = 'settings';
export const STATUS_KEY = 'status';

export type Settings = {
  enabled: boolean;
  cosmeticEnabled: boolean;
  pausedHosts: string[];
  disabledRulesetIds: string[];
  customNetworkFilters: string;
  customCosmeticFilters: string;
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  cosmeticEnabled: true,
  pausedHosts: [],
  disabledRulesetIds: [],
  customNetworkFilters: '',
  customCosmeticFilters: '',
};

export function sanitizeSettings(value: unknown): Settings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Settings>;
  return {
    enabled: raw.enabled !== false,
    cosmeticEnabled: raw.cosmeticEnabled !== false,
    pausedHosts: stringList(raw.pausedHosts),
    disabledRulesetIds: stringList(raw.disabledRulesetIds),
    customNetworkFilters:
      typeof raw.customNetworkFilters === 'string' ? raw.customNetworkFilters : '',
    customCosmeticFilters:
      typeof raw.customCosmeticFilters === 'string' ? raw.customCosmeticFilters : '',
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

let writeQueue: Promise<unknown> = Promise.resolve();

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = writeQueue.then(async () => {
    const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
    await browser.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
