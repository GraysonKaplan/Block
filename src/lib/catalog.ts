/** A filter list the options page can turn on or off as one unit. */
export type CatalogEntry = {
  id: string;
  title: string;
  description: string;
  /** declarativeNetRequest ruleset ids. A long list is split across several. */
  rulesetIds: string[];
  /** Extension-root paths, one per ruleset id. */
  rulesetPaths: string[];
  /** Extension-root path of the cosmetic JSON, when this list has one. */
  cosmeticPath: string | null;
};

export const STARTER_CATALOG: CatalogEntry[] = [
  {
    id: 'starter',
    title: 'Starter',
    description: 'Common ad and tracker domains shipped with the extension.',
    rulesetIds: ['starter'],
    rulesetPaths: ['rules/starter.json'],
    cosmeticPath: 'cosmetic/starter.json',
  },
];
