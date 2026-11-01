import '../../assets/base.css';
import './style.css';
import { required } from '../../lib/dom';
import { loadCatalog } from '../../lib/extension-catalog';
import { loadSettings, STATUS_KEY, updateSettings, type Settings } from '../../lib/settings';

const enabled = required<HTMLButtonElement>('#enabled');
const cosmetic = required<HTMLButtonElement>('#cosmetic');
const lists = required<HTMLElement>('#lists');
const network = required<HTMLTextAreaElement>('#network');
const cosmeticFilters = required<HTMLTextAreaElement>('#cosmetic-filters');
const save = required<HTMLButtonElement>('#save');
const status = required<HTMLElement>('#status');

let settings: Settings = await loadSettings();
const catalog = await loadCatalog();

enabled.addEventListener('click', () => {
  settings = { ...settings, enabled: !settings.enabled };
  paint();
  void updateSettings({ enabled: settings.enabled });
});

cosmetic.addEventListener('click', () => {
  settings = { ...settings, cosmeticEnabled: !settings.cosmeticEnabled };
  paint();
  void updateSettings({ cosmeticEnabled: settings.cosmeticEnabled });
});

save.addEventListener('click', () => {
  save.disabled = true;
  void updateSettings({
    customNetworkFilters: network.value,
    customCosmeticFilters: cosmeticFilters.value,
  })
    .then((next) => {
      settings = next;
      paint();
    })
    .finally(() => {
      save.disabled = false;
    });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STATUS_KEY]) return;
  status.textContent = statusText(changes[STATUS_KEY].newValue);
});

network.value = settings.customNetworkFilters;
cosmeticFilters.value = settings.customCosmeticFilters;
renderLists();
paint();
status.textContent = statusText((await browser.storage.local.get(STATUS_KEY))[STATUS_KEY]);

function renderLists() {
  for (const entry of catalog) {
    const row = document.createElement('label');
    row.className = 'list';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.id = entry.id;
    input.addEventListener('change', () => {
      const disabled = new Set(settings.disabledRulesetIds);
      if (input.checked) disabled.delete(entry.id);
      else disabled.add(entry.id);
      settings = { ...settings, disabledRulesetIds: [...disabled] };
      void updateSettings({ disabledRulesetIds: settings.disabledRulesetIds });
    });

    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = entry.title;
    const description = document.createElement('span');
    description.className = 'hint';
    description.textContent = entry.description;
    text.append(title, document.createElement('br'), description);

    row.append(input, text);
    lists.append(row);
  }
}

function paint() {
  enabled.setAttribute('aria-checked', settings.enabled ? 'true' : 'false');
  cosmetic.setAttribute('aria-checked', settings.cosmeticEnabled ? 'true' : 'false');
  for (const input of lists.querySelectorAll<HTMLInputElement>('input[data-id]')) {
    const id = input.dataset.id ?? '';
    input.checked = !settings.disabledRulesetIds.includes(id);
    input.disabled = !settings.enabled;
  }
}

function statusText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'Rules are up to date.';
}
