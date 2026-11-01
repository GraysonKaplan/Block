import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STARTER_CATALOG, type CatalogEntry } from '../src/lib/catalog';
import { compileFilterList, type DnrRule } from '../src/lib/filters';
import { isHostname } from '../src/lib/hosts';

/** Chrome's guaranteed static-rule floor. Extra shards stay individually inside it. */
const RULES_PER_FILE = 30_000;

const UASSETS = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master';

/**
 * The lists uBlock Origin turns on by default.
 * Annoyance lists stay off: they hide more than ads and break more sites.
 */
const FILTER_LISTS: Array<{ id: string; title: string; description: string; urls: string[] }> = [
  {
    id: 'easylist',
    title: 'EasyList',
    description: 'Primary ad list.',
    urls: [
      'https://easylist.to/easylist/easylist.txt',
      'https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt',
    ],
  },
  {
    id: 'easyprivacy',
    title: 'EasyPrivacy',
    description: 'Tracker list.',
    urls: [
      'https://easylist.to/easylist/easyprivacy.txt',
      'https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt',
    ],
  },
  {
    id: 'ublock-filters',
    title: 'uBlock filters',
    description: 'Extra ad filters maintained alongside EasyList.',
    urls: [`${UASSETS}/filters/filters.txt`],
  },
  {
    id: 'ublock-badware',
    title: 'uBlock badware',
    description: 'Malware and badware domains.',
    urls: [`${UASSETS}/filters/badware.txt`],
  },
  {
    id: 'ublock-privacy',
    title: 'uBlock privacy',
    description: 'Privacy filters from uBlock.',
    urls: [`${UASSETS}/filters/privacy.txt`],
  },
  {
    id: 'ublock-quick-fixes',
    title: 'uBlock quick fixes',
    description: 'Short-lived fixes for ads that just started slipping through.',
    urls: [`${UASSETS}/filters/quick-fixes.txt`],
  },
  {
    id: 'ublock-unbreak',
    title: 'uBlock unbreak',
    description: 'Exceptions that keep sites working.',
    urls: [`${UASSETS}/filters/unbreak.txt`],
  },
  {
    id: 'peter-lowe',
    title: 'Peter Lowe',
    description: 'Ad and tracking server list.',
    urls: [
      'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',
    ],
  },
];

const CONDITIONS: Record<string, boolean> = {
  true: true,
  false: false,
  env_chromium: true,
  env_firefox: false,
  env_edge: false,
  env_safari: false,
  env_mobile: false,
  env_mv3: true,
  ext_ubol: false,
  cap_html_filtering: false,
  cap_user_stylesheet: true,
  cap_ipaddress: false,
};

const ALLOWED_TYPES = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
]);

const root = path.resolve(import.meta.dirname, '..');
const catalog: CatalogEntry[] = [...STARTER_CATALOG];
const unknownConditions = new Set<string>();

for (const source of FILTER_LISTS) {
  process.stdout.write(`Fetching ${source.title}\n`);
  const text = await fetchList(source.urls);
  const compiled = compileFilterList(text, { warningLimit: 0 });
  const shards = shard(compiled.rules, source.id);
  const rulesetIds: string[] = [];
  const rulesetPaths: string[] = [];

  for (const piece of shards) {
    assertRules(piece.rules, piece.id);
    const rulesetPath = `rules/generated/${piece.id}.json`;
    await writeJson(path.join(root, 'public', rulesetPath), piece.rules);
    rulesetIds.push(piece.id);
    rulesetPaths.push(rulesetPath);
  }

  let cosmeticPath: string | null = null;
  const cosmeticCount =
    compiled.cosmetic.generic.length +
    Object.keys(compiled.cosmetic.hosts).length +
    Object.keys(compiled.cosmetic.except).length;
  if (cosmeticCount > 0) {
    cosmeticPath = `cosmetic/generated/${source.id}.json`;
    await writeJson(path.join(root, 'public', cosmeticPath), compiled.cosmetic);
  }

  if (rulesetIds.length === 0 && !cosmeticPath) {
    process.stdout.write(`${source.title}: nothing compiled\n`);
    continue;
  }

  catalog.push({
    id: source.id,
    title: source.title,
    description: source.description,
    rulesetIds,
    rulesetPaths,
    cosmeticPath,
  });

  const reasonText = Object.entries(compiled.stats.reasons)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  process.stdout.write(
    `${source.title}: ${compiled.stats.network} network rules across ${rulesetIds.length} file(s), ${compiled.stats.cosmetic} cosmetic, ${compiled.stats.skipped} skipped${reasonText ? ` (${reasonText})` : ''}\n`,
  );
}

const resources = catalog.flatMap((entry) =>
  entry.rulesetIds.map((id, index) => ({
    id,
    enabled: true,
    path: entry.rulesetPaths[index],
  })),
);

await writeJson(path.join(root, 'ruleset-manifest.json'), resources);
await writeJson(path.join(root, 'public', 'rules', 'index.json'), catalog);
process.stdout.write(`Wrote ${resources.length} rulesets\n`);

async function fetchList(urls: string[]): Promise<string> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return await expandList(url, new Set());
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors.join('\n'));
}

async function expandList(url: string, seen: Set<string>): Promise<string> {
  if (seen.has(url)) return '';
  seen.add(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const text = await response.text();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const stack: Array<{ saved: boolean; condition: boolean }> = [];
  let active = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('!#if')) {
      const condition = conditionIsActive(trimmed.slice(4).trim());
      stack.push({ saved: active, condition });
      active = active && condition;
      continue;
    }
    if (trimmed === '!#else' || trimmed.startsWith('!#else ')) {
      const frame = stack.at(-1);
      if (frame) active = frame.saved && !frame.condition;
      continue;
    }
    if (trimmed === '!#endif') {
      const frame = stack.pop();
      active = frame ? frame.saved : true;
      continue;
    }
    if (!active) continue;

    const include = /^!#include\s+(\S+)/.exec(trimmed);
    if (include) {
      const name = include[1];
      if (!name.includes('..') && !name.includes('://') && !name.startsWith('/')) {
        out.push(await expandList(base + name, seen));
      }
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

function conditionIsActive(expression: string): boolean {
  const negated = expression.startsWith('!');
  const name = (negated ? expression.slice(1) : expression).trim();
  if (!Object.hasOwn(CONDITIONS, name)) {
    if (!unknownConditions.has(expression)) {
      unknownConditions.add(expression);
      process.stdout.write(`Unknown filter condition "${expression}", skipping that branch\n`);
    }
    return false;
  }
  const value = CONDITIONS[name];
  return negated ? !value : value;
}

function shard(rules: DnrRule[], id: string): Array<{ id: string; rules: DnrRule[] }> {
  const pieces: Array<{ id: string; rules: DnrRule[] }> = [];
  for (let index = 0; index < rules.length; index += RULES_PER_FILE) {
    const slice = rules.slice(index, index + RULES_PER_FILE).map((rule, ruleIndex) => ({
      ...rule,
      id: ruleIndex + 1,
    }));
    const shardId = pieces.length === 0 ? id : `${id}-${pieces.length + 1}`;
    pieces.push({ id: shardId, rules: slice });
  }
  return pieces;
}

function assertRules(rules: DnrRule[], id: string) {
  const ids = new Set<number>();
  for (const rule of rules) {
    if (!Number.isInteger(rule.id) || rule.id < 1 || ids.has(rule.id)) {
      throw new Error(`${id} has a bad rule id ${rule.id}`);
    }
    ids.add(rule.id);
    if (!rule.condition.urlFilter && !rule.condition.requestDomains) {
      throw new Error(`${id} rule ${rule.id} has no URL or domain match`);
    }
    if (rule.condition.urlFilter && (rule.condition.urlFilter.length > 128 || rule.condition.urlFilter.startsWith('||*'))) {
      throw new Error(`${id} rule ${rule.id} has an invalid urlFilter`);
    }
    for (const domains of [
      rule.condition.requestDomains,
      rule.condition.initiatorDomains,
      rule.condition.excludedInitiatorDomains,
    ]) {
      if (!domains) continue;
      if (domains.length === 0 || domains.length > 50) {
        throw new Error(`${id} rule ${rule.id} has ${domains.length} domains`);
      }
      for (const domain of domains) {
        if (!isHostname(domain)) throw new Error(`${id} rule ${rule.id} has a bad domain ${domain}`);
      }
    }
    for (const types of [rule.condition.resourceTypes, rule.condition.excludedResourceTypes]) {
      if (!types) continue;
      for (const type of types) {
        if (!ALLOWED_TYPES.has(type)) throw new Error(`${id} rule ${rule.id} has resource type ${type}`);
      }
    }
    if (
      rule.action.type === 'allowAllRequests' &&
      (rule.condition.resourceTypes?.length !== 1 || rule.condition.resourceTypes[0] !== 'main_frame')
    ) {
      throw new Error(`${id} rule ${rule.id} uses allowAllRequests without a main frame`);
    }
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}
