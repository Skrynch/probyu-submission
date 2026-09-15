import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FamilyAction } from '@probyu/contracts/types';

export const POLICY = 'synthetic-m2-v1';
export const DOCUMENT = {
  version: POLICY,
  text: 'Учебное согласие: разрешить базовый текстовый сценарий в локальном стенде. Используются только синтетические данные; внешний AI выключен.',
  history:
    'Необязательно: сохранять учебную историю для будущей карты. Отказ не закрывает базовый текстовый сценарий.',
  synthetic: true as const,
};
export class AccessError extends Error {
  constructor(
    public readonly code:
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'INVALID_REQUEST'
      | 'CONFLICT'
      | 'NOT_FOUND'
      | 'OFFER_EXPIRED'
      | 'EXPIRED_PROOF'
      | 'INVALID_CODE'
      | 'RATE_LIMITED'
      | 'UNAVAILABLE',
    public readonly status = 403,
    public readonly remainingAttempts?: number,
  ) {
    super(code);
  }
}
export function secret() {
  return randomBytes(32).toString('base64url');
}
export function keyed(key: string, purpose: string, value: string) {
  return createHmac('sha256', key).update(`${purpose}:${value}`).digest('hex');
}
export function actionHash(action: FamilyAction) {
  validateAction(action);
  // FamilyAction is flat; code-unit ordering is stable across locale/ICU/processes.
  const sorted = Object.fromEntries(
    Object.keys(action)
      .sort()
      .map((k) => [k, action[k as keyof FamilyAction]]),
  );
  return createHash('sha256')
    .update(JSON.stringify({ action: sorted, policy: POLICY }))
    .digest('hex');
}
export function validateAction(a: FamilyAction) {
  const fields: Record<FamilyAction['kind'], string[]> = {
    ACTIVATE: ['kind', 'documentVersion', 'ageBand', 'text', 'history'],
    CONSENT: ['kind', 'childId', 'documentVersion', 'purpose', 'granted'],
    HANDOFF: ['kind', 'childId'],
    RETURN: ['kind'],
    PAUSE: ['kind', 'childId'],
    RESUME: ['kind', 'childId'],
    REVOKE_BROWSER: ['kind'],
  };
  const expected = fields[a.kind];
  if (Object.keys(a).length !== expected.length || expected.some((k) => !(k in a)))
    throw new AccessError('INVALID_REQUEST', 400);
  if ('documentVersion' in a && a.documentVersion !== POLICY)
    throw new AccessError('CONFLICT', 409);
}

export function equalDigest(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || !/^[a-f0-9]{64}$/.test(left)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
