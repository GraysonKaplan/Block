import { hostChain } from './hosts';
import { stringList, stringMap } from './records';
import { emptyCosmetic, type CosmeticRules } from './filters';

export function normalizeCosmetic(value: unknown): CosmeticRules {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<CosmeticRules>;
  return {
    generic: stringList(raw.generic),
    genericExcept: stringMap(raw.genericExcept),
    hosts: stringMap(raw.hosts),
    except: stringMap(raw.except),
  };
}

export function mergeCosmetic(parts: CosmeticRules[]): CosmeticRules {
  const merged = emptyCosmetic();
  for (const part of parts) {
    merged.generic.push(...part.generic);
    copyMap(part.genericExcept, merged.genericExcept);
    copyMap(part.hosts, merged.hosts);
    copyMap(part.except, merged.except);
  }
  merged.generic = [...new Set(merged.generic)];
  return merged;
}

export function selectorsFor(rules: CosmeticRules, host: string): string[] {
  const selected = new Set(rules.generic);
  for (const name of hostChain(host)) {
    for (const selector of rules.genericExcept[name] ?? []) selected.delete(selector);
  }
  for (const name of hostChain(host)) {
    for (const selector of rules.hosts[name] ?? []) selected.add(selector);
  }
  for (const name of hostChain(host)) {
    for (const selector of rules.except[name] ?? []) selected.delete(selector);
  }
  return [...selected];
}

export function cosmeticCss(selectors: string[]): string {
  if (selectors.length === 0) return '';
  const blocks: string[] = [];
  for (let index = 0; index < selectors.length; index += 500) {
    blocks.push(`${selectors.slice(index, index + 500).join(',')}{display:none !important}`);
  }
  return blocks.join('\n');
}

function copyMap(from: Record<string, string[]>, to: Record<string, string[]>) {
  for (const [key, values] of Object.entries(from)) {
    to[key] = [...new Set([...(to[key] ?? []), ...values])];
  }
}
