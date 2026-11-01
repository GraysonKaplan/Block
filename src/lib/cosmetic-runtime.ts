import { browser } from 'wxt/browser';
import { cosmeticCss, mergeCosmetic, normalizeCosmetic, selectorsFor } from './cosmetic';
import { loadCatalog } from './extension-catalog';
import { compileFilterList, emptyCosmetic, type CosmeticRules } from './filters';
import { hostIsCovered } from './hosts';
import { loadSettings } from './settings';

const fileCache = new Map<string, Promise<CosmeticRules>>();
let listCache: { key: string; rules: CosmeticRules } | null = null;
const cssCache = new Map<string, string>();

export async function cosmeticCssForHost(host: string): Promise<string> {
  const settings = await loadSettings();
  if (!settings.enabled || !settings.cosmeticEnabled) return '';
  if (settings.pausedHosts.some((root) => hostIsCovered(host, root))) return '';

  const listKey = [...settings.disabledRulesetIds].sort().join('|');
  if (!listCache || listCache.key !== listKey) {
    const catalog = await loadCatalog();
    const disabled = new Set(settings.disabledRulesetIds);
    const parts = await Promise.all(
      catalog
        .filter((entry) => entry.cosmeticPath && !disabled.has(entry.id))
        .map((entry) => loadCosmeticFile(entry.cosmeticPath as string)),
    );
    listCache = { key: listKey, rules: mergeCosmetic(parts) };
    cssCache.clear();
  }

  const cacheKey = `${listKey}\n${host}`;
  let css = cssCache.get(cacheKey);
  if (css === undefined) {
    css = cosmeticCss(selectorsFor(listCache.rules, host));
    cssCache.set(cacheKey, css);
  }

  if (!settings.customCosmeticFilters.trim()) return css;
  const custom = cosmeticCss(
    selectorsFor(compileFilterList(settings.customCosmeticFilters).cosmetic, host),
  );
  return custom ? `${css}\n${custom}` : css;
}

function loadCosmeticFile(path: string): Promise<CosmeticRules> {
  const cached = fileCache.get(path);
  if (cached) return cached;
  const pending = fetch(browser.runtime.getURL(`/${path}` as '/cosmetic/starter.json'))
    .then(async (response) => {
      if (!response.ok) return emptyCosmetic();
      return normalizeCosmetic(await response.json());
    })
    .catch(() => emptyCosmetic());
  fileCache.set(path, pending);
  return pending;
}
