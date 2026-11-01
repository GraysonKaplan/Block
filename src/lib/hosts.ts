const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isHostname(host: string): boolean {
  return host.length > 0 && host.length <= 253 && HOSTNAME.test(host);
}

/** Lowercase a tab hostname and fold a leading www. into the parent host. */
export function normalizeHost(hostname: string): string | null {
  const trimmed = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.includes('*') || trimmed.includes('/') || trimmed.includes(':')) {
    return null;
  }
  const host = trimmed.startsWith('www.') ? trimmed.slice(4) : trimmed;
  return isHostname(host) ? host : null;
}

export function hostIsCovered(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

/** Host plus each parent that still has a dot, so example.com matches a.b.example.com. */
export function hostChain(host: string): string[] {
  const labels = host.split('.');
  const chain: string[] = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    chain.push(labels.slice(index).join('.'));
  }
  return chain;
}
