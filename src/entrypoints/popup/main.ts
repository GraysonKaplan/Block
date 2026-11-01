import '../../assets/base.css';
import './style.css';
import { required } from '../../lib/dom';

type TabState = {
  enabled: boolean;
  host: string | null;
  pausable: boolean;
  paused: boolean;
  blockedCount: number;
  error?: string;
};

const enabled = required<HTMLButtonElement>('#enabled');
const statusLine = required<HTMLElement>('#status-line');
const hostLine = required<HTMLElement>('#host');
const countLine = required<HTMLElement>('#count');
const pause = required<HTMLButtonElement>('#pause');
const options = required<HTMLButtonElement>('#options');

let current: TabState | null = null;

enabled.addEventListener('click', () => {
  if (!current) return;
  void send({ type: 'set-enabled', enabled: !current.enabled }).then(() => refresh());
});

pause.addEventListener('click', () => {
  if (!current?.host) return;
  void send({ type: 'set-paused', host: current.host, paused: !current.paused }).then(() => refresh());
});

options.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

void refresh();

async function refresh() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    render({ enabled: true, host: null, pausable: false, paused: false, blockedCount: 0 });
    return;
  }
  render(await send({ type: 'get-tab-state', tabId: tab.id }));
}

function render(state: TabState) {
  current = state;
  enabled.setAttribute('aria-checked', state.enabled ? 'true' : 'false');
  statusLine.textContent = state.error
    ? state.error
    : state.enabled
      ? 'Blocking is on'
      : 'Blocking is off';
  hostLine.textContent = state.host ?? 'This page cannot be filtered';
  countLine.textContent = `${state.blockedCount} blocked`;
  pause.disabled = !state.enabled || !state.pausable || !state.host;
  pause.textContent = state.paused ? 'Resume on this site' : 'Pause on this site';
}

function send(message: Record<string, unknown>): Promise<TabState> {
  return browser.runtime.sendMessage(message) as Promise<TabState>;
}
