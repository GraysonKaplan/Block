import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectorsFor } from '../src/lib/cosmetic';
import { compileFilterList } from '../src/lib/filters';
import { isHostname } from '../src/lib/hosts';
import { rulesForSettings } from '../src/lib/dynamic-rules';

const merged = compileFilterList(`! comment
||doubleclick.net^
||googlesyndication.com^
||tracker.example^$script,third-party
`);
assert.equal(merged.rules.length, 2);
assert.deepEqual(merged.rules[0].condition.requestDomains, [
  'doubleclick.net',
  'googlesyndication.com',
]);
assert.equal(merged.rules[0].action.type, 'block');
assert.equal(merged.rules[0].priority, 1);
assert.equal(merged.rules[1].condition.domainType, 'thirdParty');
assert.deepEqual(merged.rules[1].condition.resourceTypes, ['script']);

const typed = compileFilterList('||ads.example/file.js^$image,third-party');
assert.equal(typed.rules[0].condition.urlFilter, '||ads.example/file.js^');
assert.deepEqual(typed.rules[0].condition.resourceTypes, ['image']);

const important = compileFilterList(`||bad.example^$important
@@||bad.example^$important
@@||good.example^$document
@@||cosmetic.example^$generichide
||popup.example^$popup
`);
assert.equal(important.rules.length, 3);
assert.equal(important.rules.find((rule) => rule.action.type === 'block')?.priority, 4);
assert.equal(important.rules.find((rule) => rule.action.type === 'allow')?.priority, 5);
const documentAllow = important.rules.find((rule) => rule.action.type === 'allowAllRequests');
assert.ok(documentAllow);
assert.deepEqual(documentAllow?.condition.resourceTypes, ['main_frame']);
assert.equal(documentAllow?.condition.requestDomains?.[0], 'good.example');
assert.ok(important.stats.reasons['option popup']);

const domains = compileFilterList('||cdn.example^$domain=news.example|~m.news.example');
assert.deepEqual(domains.rules[0].condition.initiatorDomains, ['news.example']);
assert.deepEqual(domains.rules[0].condition.excludedInitiatorDomains, ['m.news.example']);

const custom = compileFilterList('||custom.example^', { priorityBias: 10, idStart: 1000 });
assert.equal(custom.rules[0].priority, 11);
assert.equal(custom.rules[0].id, 1000);

const cosmetic = compileFilterList(`##.ad-box
example.com##.sponsor
example.com#@#.ad-box
~skip.example##.ad-box
`);
const scriptlet = compileFilterList('example.com##+js(set, ads, undefined)\nexample.com##.ok\nexample.com##.ad:remove()');
assert.deepEqual(selectorsFor(scriptlet.cosmetic, 'example.com'), ['.ok']);

assert.deepEqual(selectorsFor(cosmetic.cosmetic, 'example.com'), ['.sponsor']);
assert.deepEqual(selectorsFor(cosmetic.cosmetic, 'other.example'), ['.ad-box']);
assert.deepEqual(selectorsFor(cosmetic.cosmetic, 'skip.example'), []);

const paused = rulesForSettings({
  enabled: true,
  cosmeticEnabled: true,
  pausedHosts: ['www.nytimes.com'],
  disabledRulesetIds: [],
  customNetworkFilters: 'example.com##.slot',
  customCosmeticFilters: '',
});
assert.equal(paused.rules[0].action.type, 'allowAllRequests');
assert.deepEqual(paused.rules[0].condition.requestDomains, ['nytimes.com']);
assert.equal(paused.rules[0].priority, 100);
assert.match(paused.warnings.join('\n'), /cosmetic/);

const starter = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../public/rules/starter.json'), 'utf8'),
) as Array<{ id: number; condition: { requestDomains: string[] } }>;
assert.equal(new Set(starter.map((rule) => rule.id)).size, starter.length);
for (const domain of starter[0].condition.requestDomains) {
  assert.equal(isHostname(domain), true, domain);
}

process.stdout.write('parser checks passed\n');
