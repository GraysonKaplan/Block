import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

type RuleResource = {
  id: string;
  enabled: boolean;
  path: string;
};

const rulesets = JSON.parse(
  readFileSync(new URL('./ruleset-manifest.json', import.meta.url), 'utf8'),
) as RuleResource[];

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Block',
    description: 'Personal ad blocker. Loaded unpacked, not published.',
    permissions: [
      'declarativeNetRequest',
      'declarativeNetRequestFeedback',
      'storage',
      'tabs',
    ],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    declarative_net_request: {
      rule_resources: rulesets,
    },
  },
});
