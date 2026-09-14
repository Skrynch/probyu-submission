import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { AccessError, equalDigest } from './policy.js';

function normalizeIp(value: string): string {
  if (!isIP(value) || value.includes('%')) throw new AccessError('FORBIDDEN');
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  // Node sockets may represent IPv4 peers as IPv4-mapped IPv6.
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16),
    low = parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function ingressIp(request: FastifyRequest, proxyKey?: string): string {
  const peer = normalizeIp(request.raw.socket.remoteAddress ?? '');
  if (proxyKey === undefined) return peer;
  const address = request.headers['x-probyu-client-ip'];
  if (
    !['127.0.0.1', '::1'].includes(peer) ||
    !equalDigest(request.headers['x-probyu-proxy-key'], proxyKey) ||
    typeof address !== 'string'
  )
    throw new AccessError('FORBIDDEN');
  return normalizeIp(address);
}
