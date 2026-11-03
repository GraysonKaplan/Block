import { cosmeticCssForHost } from '../lib/cosmetic-runtime';
import { rulesForSettings } from '../lib/dynamic-rules';
import { loadCatalog } from '../lib/extension-catalog';
import type { DnrRule } from '../lib/filters';
import { hostIsCovered, normalizeHost } from '../lib/hosts';
import {
  loadSettings,
  sanitizeSettings,
  SETTINGS_KEY,
  STATUS_KEY,
  updateSettings,
  type Settings,
} from '../lib/settings';

type TabState = {
  enabled: boolean;
  host: string | null;
  pausable: boolean;
  paused: boolean;
  blockedCount: number;
};

type Message =
  | { type: 'get-tab-state'; tabId: number }
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'set-paused'; host: string; paused: boolean }
  | { type: 'cosmetic-css'; host: string };

const blockedCounts = new Map<number, number>();

export default defineBackground(() => {
  void browser.action.setBadgeBackgroundColor({ color: '#d0893a' });
  const action = browser.action as typeof browser.action & {
    setBadgeTextColor?: (details: { color: string }) => Promise<void>;
  };
  if (action.setBadgeTextColor) void action.setBadgeTextColor({ color: '#1c140c' });

  browser.runtime.onInstalled.addListener(() => {
    void loadSettings().then((settings) => enqueue(settings));
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    enqueue(sanitizeSettings(changes[SETTINGS_KEY].newValue));
  });

  browser.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;

    if (message.type === 'get-tab-state') {
      void getTabState(message.tabId).then(sendResponse, (error: unknown) => {
        sendResponse({ error: errorText(error) });
      });
      return true;
    }

    if (message.type === 'set-enabled') {
      void updateSettings({ enabled: message.enabled }).then(
        (settings) => sendResponse({ ok: true, enabled: settings.enabled }),
        (error: unknown) => sendResponse({ error: errorText(error) }),
      );
      return true;
    }

    if (message.type === 'set-paused') {
      void setPaused(message.host, message.paused).then(
        (settings) => sendResponse({ ok: true, pausedHosts: settings.pausedHosts }),
        (error: unknown) => sendResponse({ error: errorText(error) }),
      );
      return true;
    }

    if (message.type === 'cosmetic-css') {
      void cosmeticCssForHost(message.host).then(sendResponse, () => sendResponse(''));
      return true;
    }
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    blockedCounts.set(tabId, 0);
    showBadge(tabId, '');
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    blockedCounts.delete(tabId);
  });

  // Fired only for unpacked extensions. Enough for a personal install.
  browser.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
    const tabId = info.request.tabId;
    if (tabId < 0) return;
    const count = (blockedCounts.get(tabId) ?? 0) + 1;
    blockedCounts.set(tabId, count);
    showBadge(tabId, count > 999 ? '999+' : String(count));
  });

  void loadSettings().then((settings) => enqueue(settings));
});

let chain: Promise<unknown> = Promise.resolve();

function enqueue(settings: Settings) {
  chain = chain
    .then(() => apply(settings))
    .catch((error: unknown) => browser.storage.local.set({ [STATUS_KEY]: errorText(error) }));
}

async function apply(settings: Settings) {
  const catalog = await loadCatalog();
  await syncRulesets(settings, catalog);
  const { rules, warnings } = rulesForSettings(settings);
  await replaceDynamicRules(rules);
  await browser.storage.local.set({
    [STATUS_KEY]: warnings.length > 0 ? warnings.join('\n') : '',
  });
}

async function syncRulesets(
  settings: Settings,
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
) {
  const disabled = new Set(settings.disabledRulesetIds);
  const want = new Set<string>();
  if (settings.enabled) {
    for (const entry of catalog) {
      if (disabled.has(entry.id)) continue;
      for (const id of entry.rulesetIds) want.add(id);
    }
  }

  const enabled = new Set(await browser.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = [...want].filter((id) => !enabled.has(id));
  const disableRulesetIds = [...enabled].filter((id) => !want.has(id));
  if (enableRulesetIds.length === 0 && disableRulesetIds.length === 0) return;

  await browser.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds,
    disableRulesetIds,
  });
}

async function replaceDynamicRules(rules: DnrRule[]) {
  const existing = await browser.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  if (removeRuleIds.length === 0 && rules.length === 0) return;
  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules as Browser.declarativeNetRequest.Rule[],
  });
}

async function setPaused(host: string, paused: boolean): Promise<Settings> {
  const normalized = normalizeHost(host);
  if (!normalized) throw new Error('This page does not have a site to pause.');
  return updateSettings(
    paused
      ? addPause(await loadSettings(), normalized)
      : removePause(await loadSettings(), normalized),
  );
}

function addPause(settings: Settings, host: string): Partial<Settings> {
  if (settings.pausedHosts.some((root) => hostIsCovered(host, root))) return {};
  return { pausedHosts: [...settings.pausedHosts, host] };
}

function removePause(settings: Settings, host: string): Partial<Settings> {
  return {
    pausedHosts: settings.pausedHosts.filter((root) => !hostIsCovered(host, root)),
  };
}

function showBadge(tabId: number, text: string) {
  // Prerendered and just-closed tabs reject with "No tab with id".
  void browser.action.setBadgeText({ tabId, text }).catch((error: unknown) => {
    if (missingTab(error)) {
      blockedCounts.delete(tabId);
      return;
    }
    console.error(error);
  });
}

function missingTab(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('No tab with id');
}

async function getTabState(tabId: number): Promise<TabState> {
  const settings = await loadSettings();
  let tab: Awaited<ReturnType<typeof browser.tabs.get>>;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (error) {
    if (!missingTab(error)) throw error;
    return {
      enabled: settings.enabled,
      host: null,
      pausable: false,
      paused: false,
      blockedCount: 0,
    };
  }
  let host: string | null = null;
  let pausable = false;
  if (tab.url) {
    try {
      const url = new URL(tab.url);
      pausable = url.protocol === 'http:' || url.protocol === 'https:';
      host = pausable ? normalizeHost(url.hostname) : null;
    } catch {
      pausable = false;
    }
  }

  return {
    enabled: settings.enabled,
    host,
    pausable,
    paused: !!host && settings.pausedHosts.some((root) => hostIsCovered(host, root)),
    blockedCount: await blockedCount(tabId),
  };
}

async function blockedCount(tabId: number): Promise<number> {
  if (blockedCounts.has(tabId)) return blockedCounts.get(tabId) ?? 0;
  try {
    const matched = await browser.declarativeNetRequest.getMatchedRules({ tabId });
    const count = matched.rulesMatchedInfo?.length ?? 0;
    blockedCounts.set(tabId, count);
    return count;
  } catch {
    return 0;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
