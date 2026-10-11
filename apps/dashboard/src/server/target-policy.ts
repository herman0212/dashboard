import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError } from './security.js';

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const)
  blockedV6.addSubnet(ip, prefix, 'ipv6');
const metadata = new BlockList();
metadata.addSubnet('169.254.0.0', 16, 'ipv4');
metadata.addAddress('fd00:ec2::254', 'ipv6');
export function addressPolicy(address: string, allowPrivate: boolean): boolean {
  const version = isIP(address);
  if (!version) return false;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  // BlockList handles IPv4-mapped IPv6 addresses too; metadata is never opt-in.
  if (metadata.check(address, family)) return false;
  if (allowPrivate) return true;
  return (
    !(version === 4 ? blocked : blockedV6).check(address, family) &&
    (version === 4 || /^[23][0-9a-f]{3}:/i.test(address))
  );
}
export async function checkTargetPolicy(
  target: URL,
  allowedHosts: string[] = [],
  resolve: (
    host: string,
    options: { all: true; verbatim: true },
  ) => Promise<{ address: string; family: number }[]> = lookup,
): Promise<void> {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal'))
    throw new HttpError(403, 'TargetBlocked', 'Cloud metadata targets cannot be scanned.');
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolve(host, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), 4000);
        }),
      ]);
    } catch {
      throw new HttpError(400, 'TargetDnsUnavailable', 'Target DNS could not be resolved inside the runner.');
    } finally {
      clearTimeout(timer);
    }
  }
  const allowed = allowedHosts.some((v) => v.replace(/^\[|\]$/g, '').toLowerCase() === host);
  if (!addresses.length || addresses.some((v) => !addressPolicy(v.address, allowed)))
    throw new HttpError(
      403,
      'TargetBlocked',
      'Target resolves to a restricted address. Private targets require an explicit runner host allowlist; metadata is always blocked.',
    );
}
