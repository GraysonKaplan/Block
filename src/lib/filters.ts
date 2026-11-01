import { isHostname } from './hosts';

/**
 * Chrome drops an entire ruleset if one urlFilter is invalid.
 * Patterns longer than this are skipped instead of emitted.
 */
const MAX_URL_FILTER_LENGTH = 128;

/** Stay under the compiled-rule size limit when many domains share one rule. */
const MAX_DOMAINS_PER_RULE = 50;

const RESOURCE_TYPES: Record<string, string> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  font: 'font',
  media: 'media',
  ping: 'ping',
  websocket: 'websocket',
  other: 'other',
  document: 'main_frame',
  doc: 'main_frame',
};

/** These change cosmetic behavior only. They are not network matches. */
const COSMETIC_MODIFIERS = new Set([
  'elemhide',
  'generichide',
  'specifichide',
  'ehide',
  'ghide',
  'shide',
]);

const PROCEDURAL =
  /:(?:has-text|matches-css(?:-before|-after)?|matches-attr|matches-path|xpath|upward|remove|style|min-text-length|watch-attr|watch-attrs)\b|:-abp-|\+js\(/;

const MARKERS = ['#@?#', '#?#', '#@$#', '#$#', '#@#', '##'] as const;

export type DnrRule = {
  id: number;
  priority: number;
  action: { type: 'block' | 'allow' | 'allowAllRequests' };
  condition: {
    urlFilter?: string;
    requestDomains?: string[];
    resourceTypes?: string[];
    excludedResourceTypes?: string[];
    domainType?: 'firstParty' | 'thirdParty';
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
    isUrlFilterCaseSensitive?: true;
  };
};

export type CosmeticRules = {
  generic: string[];
  genericExcept: Record<string, string[]>;
  hosts: Record<string, string[]>;
  except: Record<string, string[]>;
};

export type CompileStats = {
  ignored: number;
  network: number;
  cosmetic: number;
  skipped: number;
  reasons: Record<string, number>;
};

export type CompileOutput = {
  rules: DnrRule[];
  cosmetic: CosmeticRules;
  warnings: string[];
  stats: CompileStats;
};

type NetworkDraft = {
  action: 'block' | 'allow' | 'allowAllRequests';
  priority: number;
  domain: string | null;
  urlFilter: string | null;
  resourceTypes: string[] | null;
  excludedResourceTypes: string[] | null;
  domainType: 'firstParty' | 'thirdParty' | null;
  initiatorDomains: string[] | null;
  excludedInitiatorDomains: string[] | null;
  caseSensitive: boolean;
};

type ParseOptions = {
  priorityBias?: number;
  idStart?: number;
  warningLimit?: number;
};

export function emptyCosmetic(): CosmeticRules {
  return { generic: [], genericExcept: {}, hosts: {}, except: {} };
}

export function compileFilterList(text: string, options: ParseOptions = {}): CompileOutput {
  const stats: CompileStats = {
    ignored: 0,
    network: 0,
    cosmetic: 0,
    skipped: 0,
    reasons: {},
  };
  const warnings: string[] = [];
  const warningLimit = options.warningLimit ?? 20;
  const network: NetworkDraft[] = [];
  const generic = new Set<string>();
  const genericExcept = new Map<string, Set<string>>();
  const hosts = new Map<string, Set<string>>();
  const except = new Map<string, Set<string>>();

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index].trim();
    const hostsFile = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)/.exec(line);
    if (hostsFile && isHostname(hostsFile[1].toLowerCase())) line = `||${hostsFile[1].toLowerCase()}^`;
    if (!line || line.startsWith('!') || line.startsWith('[')) {
      stats.ignored += 1;
      continue;
    }

    const parsed = parseLine(line);
    if (parsed.kind === 'skip') {
      stats.skipped += 1;
      stats.reasons[parsed.reason] = (stats.reasons[parsed.reason] ?? 0) + 1;
      if (!parsed.silent && warnings.length < warningLimit) {
        warnings.push(`Line ${lineNumber}: ${parsed.reason} (${trimLine(line)})`);
      }
      continue;
    }

    if (parsed.kind === 'cosmetic') {
      stats.cosmetic += 1;
      if (parsed.exception && parsed.include === null) {
        generic.delete(parsed.selector);
        continue;
      }
      if (parsed.exception) {
        for (const host of parsed.include ?? []) addToMap(except, host, parsed.selector);
        continue;
      }
      if (parsed.include === null) {
        generic.add(parsed.selector);
        for (const host of parsed.exclude) addToMap(genericExcept, host, parsed.selector);
        continue;
      }
      for (const host of parsed.include) addToMap(hosts, host, parsed.selector);
      continue;
    }

    network.push(...expandDomainChunks(parsed.draft));
  }

  const rules = draftsToRules(network, options.priorityBias ?? 0, options.idStart ?? 1);
  stats.network = rules.length;

  return {
    rules,
    cosmetic: {
      generic: [...generic],
      genericExcept: mapToRecord(genericExcept),
      hosts: mapToRecord(hosts),
      except: mapToRecord(except),
    },
    warnings,
    stats,
  };
}

function parseLine(
  line: string,
):
  | { kind: 'network'; draft: NetworkDraft }
  | {
      kind: 'cosmetic';
      selector: string;
      include: string[] | null;
      exclude: string[];
      exception: boolean;
    }
  | { kind: 'skip'; reason: string; silent: boolean } {
  const marker = findMarker(line);
  if (marker) {
    if (marker.marker === '#?#' || marker.marker === '#@?#') {
      return { kind: 'skip', reason: 'procedural', silent: true };
    }
    if (marker.marker === '#$#' || marker.marker === '#@$#') {
      return { kind: 'skip', reason: 'scriptlet', silent: true };
    }
    return parseCosmetic(line, marker.index, marker.marker);
  }

  let source = line;
  let exception = false;
  if (source.startsWith('@@')) {
    exception = true;
    source = source.slice(2);
  }

  const split = splitPattern(source);
  if (!split || !split.pattern) return { kind: 'skip', reason: 'pattern', silent: false };
  if (isRegex(split.pattern)) return { kind: 'skip', reason: 'regex', silent: true };

  const options = parseOptions(split.options, exception);
  if (options.kind === 'skip') return options;
  if (options.kind === 'cosmetic-only') {
    return { kind: 'skip', reason: 'cosmetic-modifier', silent: true };
  }

  const domain = pureRequestDomain(split.pattern);
  const urlFilter = domain ? null : toUrlFilter(split.pattern);
  if (!domain && !urlFilter) return { kind: 'skip', reason: 'url-filter', silent: false };

  const priority = rulePriority(exception, options.important);
  const action = exception
    ? options.allowAllRequests
      ? 'allowAllRequests'
      : 'allow'
    : 'block';

  return {
    kind: 'network',
    draft: {
      action,
      priority,
      domain,
      urlFilter,
      resourceTypes: options.allowAllRequests ? ['main_frame'] : options.resourceTypes,
      excludedResourceTypes: options.allowAllRequests ? null : options.excludedResourceTypes,
      domainType: options.domainType,
      initiatorDomains: options.initiatorDomains,
      excludedInitiatorDomains: options.excludedInitiatorDomains,
      caseSensitive: options.caseSensitive && !domain,
    },
  };
}

function parseCosmetic(
  line: string,
  index: number,
  marker: '#@#' | '##',
):
  | {
      kind: 'cosmetic';
      selector: string;
      include: string[] | null;
      exclude: string[];
      exception: boolean;
    }
  | { kind: 'skip'; reason: string; silent: boolean } {
  const selector = line.slice(index + marker.length).trim();
  if (selector.startsWith('+js(') || selector.startsWith('^')) {
    return { kind: 'skip', reason: 'scriptlet', silent: true };
  }
  if (!selector || selector.length > 400) {
    return { kind: 'skip', reason: 'cosmetic-selector', silent: false };
  }
  if (/[{}<>\\]|\/\*|\n|##/.test(selector) || PROCEDURAL.test(selector)) {
    return { kind: 'skip', reason: 'cosmetic-selector', silent: false };
  }

  const domains = parseDomainList(line.slice(0, index), ',');
  if (!domains) return { kind: 'skip', reason: 'cosmetic-domain', silent: false };

  const exception = marker === '#@#';
  if (domains.include.length === 0) {
    return {
      kind: 'cosmetic',
      selector,
      include: null,
      exclude: domains.exclude,
      exception,
    };
  }

  const excluded = new Set(domains.exclude);
  return {
    kind: 'cosmetic',
    selector,
    include: domains.include.filter((host) => !excluded.has(host)),
    exclude: [],
    exception,
  };
}

function parseOptions(
  raw: string,
  exception: boolean,
):
  | { kind: 'skip'; reason: string; silent: boolean }
  | { kind: 'cosmetic-only' }
  | {
      kind: 'ok';
      important: boolean;
      caseSensitive: boolean;
      allowAllRequests: boolean;
      resourceTypes: string[] | null;
      excludedResourceTypes: string[] | null;
      domainType: 'firstParty' | 'thirdParty' | null;
      initiatorDomains: string[] | null;
      excludedInitiatorDomains: string[] | null;
    } {
  const tokens = raw
    ? raw
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
    : [];
  const meaningful = tokens.filter((token) => !COSMETIC_MODIFIERS.has(optionName(token)));
  if (tokens.length > 0 && meaningful.length === 0) return { kind: 'cosmetic-only' };

  const included = new Set<string>();
  const excluded = new Set<string>();
  let important = false;
  let caseSensitive = false;
  let allTypes = false;
  let domainType: 'firstParty' | 'thirdParty' | null = null;
  let initiatorDomains: string[] | null = null;
  let excludedInitiatorDomains: string[] | null = null;

  for (const token of meaningful) {
    const negated = token.startsWith('~');
    const body = negated ? token.slice(1) : token;
    const equals = body.indexOf('=');
    const name = (equals === -1 ? body : body.slice(0, equals)).toLowerCase();
    const value = equals === -1 ? '' : body.slice(equals + 1);

    if (name === 'important') {
      important = true;
      continue;
    }
    if (name === 'match-case') {
      caseSensitive = true;
      continue;
    }
    if (name === 'all') {
      allTypes = true;
      continue;
    }
    if (name === 'domain') {
      if (negated) return { kind: 'skip', reason: 'domain-option', silent: false };
      const domains = parseDomainList(value, '|');
      if (!domains || (domains.include.length === 0 && domains.exclude.length === 0)) {
        return { kind: 'skip', reason: 'domain-option', silent: false };
      }
      initiatorDomains = domains.include;
      excludedInitiatorDomains = domains.exclude;
      continue;
    }

    const party = partyOption(name, negated);
    if (party === 'invalid') return { kind: 'skip', reason: 'party', silent: false };
    if (party) {
      if (domainType && domainType !== party) {
        return { kind: 'skip', reason: 'party', silent: false };
      }
      domainType = party;
      continue;
    }

    const resource = RESOURCE_TYPES[name];
    if (!resource) return { kind: 'skip', reason: `option ${name}`, silent: false };
    (negated ? excluded : included).add(resource);
  }

  if (allTypes) {
    included.clear();
    excluded.clear();
  }

  let resourceTypes: string[] | null = null;
  let excludedResourceTypes: string[] | null = null;
  if (included.size > 0) {
    for (const type of excluded) included.delete(type);
    if (included.size === 0) return { kind: 'skip', reason: 'empty-types', silent: false };
    resourceTypes = [...included].sort();
  } else if (excluded.size > 0) {
    excludedResourceTypes = [...excluded].sort();
  }

  const allowAllRequests =
    exception && resourceTypes?.length === 1 && resourceTypes[0] === 'main_frame';

  return {
    kind: 'ok',
    important,
    caseSensitive,
    allowAllRequests,
    resourceTypes,
    excludedResourceTypes,
    domainType,
    initiatorDomains,
    excludedInitiatorDomains,
  };
}

function partyOption(
  name: string,
  negated: boolean,
): 'firstParty' | 'thirdParty' | 'invalid' | null {
  const third = name === 'third-party' || name === '3p';
  const first = name === 'first-party' || name === '1p';
  if (!third && !first) return null;
  if (third) return negated ? 'firstParty' : 'thirdParty';
  return negated ? 'thirdParty' : 'firstParty';
}

function rulePriority(exception: boolean, important: boolean): number {
  if (important && exception) return 5;
  if (important) return 4;
  if (exception) return 3;
  return 1;
}

function expandDomainChunks(draft: NetworkDraft): NetworkDraft[] {
  return chunkField(chunkField([draft], 'initiatorDomains'), 'excludedInitiatorDomains');
}

function chunkField(
  drafts: NetworkDraft[],
  field: 'initiatorDomains' | 'excludedInitiatorDomains',
): NetworkDraft[] {
  const expanded: NetworkDraft[] = [];
  for (const draft of drafts) {
    const values = draft[field];
    if (!values || values.length <= MAX_DOMAINS_PER_RULE) {
      expanded.push(draft);
      continue;
    }
    for (let index = 0; index < values.length; index += MAX_DOMAINS_PER_RULE) {
      expanded.push({ ...draft, [field]: values.slice(index, index + MAX_DOMAINS_PER_RULE) });
    }
  }
  return expanded;
}

function draftsToRules(drafts: NetworkDraft[], priorityBias: number, idStart: number): DnrRule[] {
  const groups = new Map<string, { draft: NetworkDraft; domains: Set<string> }>();
  const urlDrafts: NetworkDraft[] = [];

  for (const draft of drafts) {
    if (!draft.domain) {
      urlDrafts.push(draft);
      continue;
    }
    const key = groupKey(draft);
    const group = groups.get(key);
    if (group) group.domains.add(draft.domain);
    else groups.set(key, { draft, domains: new Set([draft.domain]) });
  }

  const rules: DnrRule[] = [];
  let nextId = idStart;
  const bias = Math.min(90, Math.max(0, priorityBias));

  for (const group of groups.values()) {
    const domains = [...group.domains].sort();
    for (let index = 0; index < domains.length; index += MAX_DOMAINS_PER_RULE) {
      rules.push(toRule(group.draft, domains.slice(index, index + MAX_DOMAINS_PER_RULE), bias, nextId));
      nextId += 1;
    }
  }

  for (const draft of urlDrafts) {
    rules.push(toRule(draft, null, bias, nextId));
    nextId += 1;
  }

  return rules;
}

function toRule(
  draft: NetworkDraft,
  domains: string[] | null,
  bias: number,
  id: number,
): DnrRule {
  const condition: DnrRule['condition'] = {};
  if (domains) condition.requestDomains = domains;
  if (draft.urlFilter) condition.urlFilter = draft.urlFilter;
  if (draft.caseSensitive) condition.isUrlFilterCaseSensitive = true;
  if (draft.resourceTypes) condition.resourceTypes = draft.resourceTypes;
  if (draft.excludedResourceTypes) condition.excludedResourceTypes = draft.excludedResourceTypes;
  if (draft.domainType) condition.domainType = draft.domainType;
  if (draft.initiatorDomains?.length) condition.initiatorDomains = draft.initiatorDomains;
  if (draft.excludedInitiatorDomains?.length) {
    condition.excludedInitiatorDomains = draft.excludedInitiatorDomains;
  }
  return {
    id,
    priority: Math.min(99, draft.priority + bias),
    action: { type: draft.action },
    condition,
  };
}

function groupKey(draft: NetworkDraft): string {
  return JSON.stringify({
    action: draft.action,
    priority: draft.priority,
    resourceTypes: draft.resourceTypes,
    excludedResourceTypes: draft.excludedResourceTypes,
    domainType: draft.domainType,
    initiatorDomains: draft.initiatorDomains,
    excludedInitiatorDomains: draft.excludedInitiatorDomains,
  });
}

function pureRequestDomain(pattern: string): string | null {
  if (!pattern.startsWith('||') || !pattern.endsWith('^')) return null;
  const host = pattern.slice(2, -1).toLowerCase();
  return isHostname(host) ? host : null;
}

function toUrlFilter(pattern: string): string | null {
  if (pattern.length < 4 || pattern.length > MAX_URL_FILTER_LENGTH) return null;
  if (!/^[\x21-\x7e]+$/.test(pattern)) return null;
  if (pattern.startsWith('||*')) return null;
  if (!/[a-z0-9]{3}/i.test(pattern)) return null;
  return pattern;
}

function isRegex(pattern: string): boolean {
  if (!pattern.startsWith('/')) return false;
  for (let index = 1; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      index += 1;
      continue;
    }
    if (pattern[index] === '/') return index === pattern.length - 1;
  }
  return false;
}

function splitPattern(line: string): { pattern: string; options: string } | null {
  if (line.startsWith('/')) {
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === '\\') {
        index += 1;
        continue;
      }
      if (line[index] !== '/') continue;
      const pattern = line.slice(0, index + 1);
      const rest = line.slice(index + 1);
      if (!rest) return { pattern, options: '' };
      if (rest.startsWith('$')) return { pattern, options: rest.slice(1) };
      break;
    }
  }

  const dollar = line.indexOf('$');
  if (dollar === -1) return { pattern: line, options: '' };
  return { pattern: line.slice(0, dollar), options: line.slice(dollar + 1) };
}

function findMarker(line: string): { marker: (typeof MARKERS)[number]; index: number } | null {
  let found: { marker: (typeof MARKERS)[number]; index: number } | null = null;
  for (const marker of MARKERS) {
    const index = line.indexOf(marker);
    if (index === -1) continue;
    if (!found || index < found.index || (index === found.index && marker.length > found.marker.length)) {
      found = { marker, index };
    }
  }
  return found;
}

function parseDomainList(
  raw: string,
  separator: ',' | '|',
): { include: string[]; exclude: string[] } | null {
  if (!raw) return { include: [], exclude: [] };
  const include: string[] = [];
  const exclude: string[] = [];
  for (const part of raw.split(separator)) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const negated = token.startsWith('~');
    const host = negated ? token.slice(1) : token;
    if (!host || host.includes('*') || !isHostname(host)) return null;
    (negated ? exclude : include).push(host);
  }
  include.sort();
  exclude.sort();
  return { include: unique(include), exclude: unique(exclude) };
}

function optionName(token: string): string {
  const body = token.startsWith('~') ? token.slice(1) : token;
  const equals = body.indexOf('=');
  return (equals === -1 ? body : body.slice(0, equals)).toLowerCase();
}

function addToMap(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function mapToRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  for (const [key, values] of map) record[key] = [...values].sort();
  return record;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function trimLine(line: string): string {
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
