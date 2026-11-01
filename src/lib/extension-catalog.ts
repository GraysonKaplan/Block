import { browser } from 'wxt/browser';
import type { CatalogEntry } from './catalog';

export async function loadCatalog(): Promise<CatalogEntry[]> {
  const response = await fetch(browser.runtime.getURL('/rules/index.json'));
  if (!response.ok) throw new Error(`Could not load the filter catalog (${response.status}).`);
  const catalog = (await response.json()) as CatalogEntry[];
  if (!Array.isArray(catalog)) throw new Error('Filter catalog is not a list.');
  return catalog;
}
