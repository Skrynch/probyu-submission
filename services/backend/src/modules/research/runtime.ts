import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import {
  ANSWER_SCHEMA_VERSION,
  FAKE_ADAPTER_VERSION,
  curatedChallenges,
  type CuratedChallenge,
} from './content.js';

export type AgeBand = '8_10' | '11_12' | '13_14';
export type FakeAnswer = {
  explanation: string[];
  roleNotice: 'Это учебный ответ системы: он может ошибаться.';
  challengeKey: string;
  schemaVersion: typeof ANSWER_SCHEMA_VERSION;
};
export type GenerationInput = { question: string; ageBand: AgeBand };
export interface TextGeneration {
  readonly version: string;
  generate(input: GenerationInput, signal: AbortSignal): Promise<unknown>;
}

export class DeterministicFakeGeneration implements TextGeneration {
  readonly version = FAKE_ADAPTER_VERSION;
  async generate(input: GenerationInput, signal: AbortSignal): Promise<unknown> {
    await Promise.resolve();
    if (signal.aborted) throw signal.reason;
    const question = input.question.toLocaleLowerCase('ru-RU');
    const challengeKey = /проект|башн|устойчив/.test(question)
      ? 'paper-tower'
      : /опыт|кат|движ|наклон/.test(question)
        ? 'paper-paths'
        : 'paper-shapes';
    const lead =
      input.ageBand === '8_10'
        ? 'Хороший вопрос. Проверим идею на простом примере.'
        : input.ageBand === '11_12'
          ? 'Разберём вопрос через наблюдение и сравнение одного изменения.'
          : 'Сформулируем проверяемое предположение и изменим только один параметр.';
    return {
      explanation: [
        lead,
        'Форма и положение предмета могут менять сопротивление воздуха, опору или направление движения. Важно сравнивать варианты в одинаковых условиях.',
      ],
      roleNotice: 'Это учебный ответ системы: он может ошибаться.',
      challengeKey,
      schemaVersion: ANSWER_SCHEMA_VERSION,
    } satisfies FakeAnswer;
  }
}

export class ProviderOutcomeUnknownError extends Error {}

export function normalizeQuestion(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function questionDecision(
  question: string,
):
  | { action: 'ALLOW'; sanitized: string }
  | { action: 'BLOCK'; code: 'INPUT_BLOCKED' | 'INPUT_TOO_LONG' } {
  if (question.length > 500) return { action: 'BLOCK', code: 'INPUT_TOO_LONG' };
  if (
    question.length < 2 ||
    /(?:https?:\/\/|www\.|@[a-z0-9_]{2,}|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)/i.test(question) ||
    /(?:\+?\d[\d\s()-]{7,}\d|меня\s+зовут|я\s+живу\s+(?:на|по|в)|моя\s+школа)/iu.test(question) ||
    /(?:взрыв|бомб|поджечь|убить|самоубий|лекарств|дозиров|удуш|оруж|наркот|взлом)/iu.test(question)
  ) {
    return { action: 'BLOCK', code: 'INPUT_BLOCKED' };
  }
  return { action: 'ALLOW', sanitized: question };
}

const forbiddenOutput =
  /(?:https?:\/\/|www\.|<\/?[a-z]|javascript:|взрыв|поджечь|лекарств|дозиров|остр(?:ый|ое|ые)|розетк|батаре|съешь|выпей|сфотограф)/iu;

export function approveFakeAnswer(
  value: unknown,
  ageBand: AgeBand,
): {
  answer: FakeAnswer;
  challenge: CuratedChallenge;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OUTPUT_REJECTED');
  const object = value as Record<string, unknown>;
  const exact = ['challengeKey', 'explanation', 'roleNotice', 'schemaVersion'];
  if (
    Object.keys(object).sort().join('|') !== exact.sort().join('|') ||
    object.schemaVersion !== ANSWER_SCHEMA_VERSION ||
    object.roleNotice !== 'Это учебный ответ системы: он может ошибаться.' ||
    !Array.isArray(object.explanation) ||
    object.explanation.length < 1 ||
    object.explanation.length > 4 ||
    object.explanation.some(
      (line) =>
        typeof line !== 'string' ||
        line.length < 1 ||
        line.length > 500 ||
        forbiddenOutput.test(line),
    ) ||
    typeof object.challengeKey !== 'string'
  )
    throw new Error('OUTPUT_REJECTED');
  const challenge = curatedChallenges.find(
    (item) => item.key === object.challengeKey && item.ageBands.includes(ageBand),
  );
  if (!challenge) throw new Error('OUTPUT_REJECTED');
  return { answer: object as FakeAnswer, challenge };
}

export function requestHash(key: Buffer, question: string): string {
  return createHmac('sha256', key)
    .update('m3-question-idempotency-v1\0')
    .update(question)
    .digest('hex');
}

export function encryptJson(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decryptJson<T>(key: Buffer, value: string): T {
  const data = Buffer.from(value, 'base64url');
  if (data.length < 29) throw new Error('Encrypted research artifact is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
  ) as T;
}
