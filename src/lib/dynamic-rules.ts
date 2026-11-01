import { compileFilterList, type DnrRule } from './filters';
import { hostIsCovered, normalizeHost } from './hosts';
import type { Settings } from './settings';

/** Above every list and custom filter, below nothing the user can type. */
const PAUSE_PRIORITY = 100;
const CUSTOM_PRIORITY_BIAS = 10;
const MAX_PAUSED_HOSTS = 900;
const MAX_CUSTOM_RULES = 20_000;

export function rulesForSettings(settings: Settings): { rules: DnrRule[]; warnings: string[] } {
  if (!settings.enabled) return { rules: [], warnings: [] };

  const warnings: string[] = [];
  const rules: DnrRule[] = [];
  const paused: string[] = [];

  for (const host of settings.pausedHosts) {
    const normalized = normalizeHost(host);
    if (!normalized || paused.some((root) => hostIsCovered(normalized, root))) continue;
    paused.push(normalized);
    if (paused.length >= MAX_PAUSED_HOSTS) break;
  }

  for (const [index, host] of paused.entries()) {
    rules.push({
      id: index + 1,
      priority: PAUSE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: [host],
        resourceTypes: ['main_frame'],
      },
    });
  }

  const custom = compileFilterList(settings.customNetworkFilters, {
    priorityBias: CUSTOM_PRIORITY_BIAS,
    idStart: 1_000,
  });
  if (custom.stats.cosmetic > 0) {
    warnings.push(
      `${custom.stats.cosmetic} cosmetic filter${custom.stats.cosmetic === 1 ? '' : 's'} belong in the cosmetic box.`,
    );
  }
  if (custom.rules.length > MAX_CUSTOM_RULES) {
    warnings.push(`Custom network filters were capped at ${MAX_CUSTOM_RULES} rules.`);
  }
  rules.push(...custom.rules.slice(0, MAX_CUSTOM_RULES));
  warnings.push(...custom.warnings);

  const cosmeticBox = compileFilterList(settings.customCosmeticFilters);
  if (cosmeticBox.rules.length > 0) {
    warnings.push(
      `${cosmeticBox.rules.length} network filter${cosmeticBox.rules.length === 1 ? '' : 's'} belong in the network box.`,
    );
  }

  return { rules, warnings };
}
