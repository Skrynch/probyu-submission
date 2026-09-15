import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const RESEARCH_POLICY = 'synthetic-m3-v1';
export const FAKE_ADAPTER_VERSION = 'deterministic-fake-m3-v2';
export const LEGACY_ANSWER_SCHEMA_VERSION = 'approved-answer-m3-v1';
export const ANSWER_SCHEMA_VERSION = 'approved-answer-m3-v2';

export type ChallengeKind = 'MICRO_PROBE' | 'EXPERIENCE' | 'PROJECT';
export type CuratedChallenge = {
  id: string;
  key: string;
  version: 2;
  kind: ChallengeKind;
  title: string;
  goal: string;
  durationMinutes: number;
  resumeWindowMinutes: number;
  materials: string[];
  steps: string[];
  ageBands: Array<'8_10' | '11_12' | '13_14'>;
};

export const curatedChallenges: CuratedChallenge[] = [
  {
    id: '10000000-0000-4000-8000-000000000011',
    key: 'paper-shapes',
    version: 2,
    kind: 'MICRO_PROBE',
    title: 'Как форма бумаги меняет падение',
    goal: 'Сравнить движение одного листа в двух безопасных формах.',
    durationMinutes: 3,
    resumeWindowMinutes: 30,
    materials: ['Один обычный лист бумаги', 'Свободное место на столе или полу'],
    steps: [
      'Освободи небольшое место. Держи лист над столом или полом — не выше плеча.',
      'Отпусти плоский лист и спокойно посмотри, как он движется.',
      'Сомни тот же лист в мягкий бумажный шарик и отпусти с той же высоты.',
    ],
    ageBands: ['8_10', '11_12', '13_14'],
  },
  {
    id: '10000000-0000-4000-8000-000000000012',
    key: 'paper-paths',
    version: 2,
    kind: 'EXPERIENCE',
    title: 'Три дорожки для бумажного шарика',
    goal: 'Проверить, как наклон бумажной дорожки меняет движение.',
    durationMinutes: 7,
    resumeWindowMinutes: 120,
    materials: ['Два листа бумаги', 'Бумажный шарик', 'Стол'],
    steps: [
      'Сделай из одного листа бумажный шарик. Второй лист положи на стол как дорожку.',
      'Слегка приподними один край дорожки рукой и отпусти шарик сверху.',
      'Попробуй ещё два небольших наклона, каждый раз начиная с того же места.',
      'Выбери наблюдение, которое изменилось заметнее всего.',
    ],
    ageBands: ['8_10', '11_12', '13_14'],
  },
  {
    id: '10000000-0000-4000-8000-000000000013',
    key: 'paper-tower',
    version: 2,
    kind: 'PROJECT',
    title: 'Бумажная башня без клея',
    goal: 'Собрать устойчивую небольшую конструкцию и изменить один параметр.',
    durationMinutes: 12,
    resumeWindowMinutes: 1_440,
    materials: ['Три обычных листа бумаги', 'Ровный стол'],
    steps: [
      'Выбери ровное свободное место на столе и убери хрупкие предметы.',
      'Сложи или сверни листы руками так, чтобы из них получились устойчивые опоры.',
      'Поставь опоры рядом и положи сверху оставшийся лист. Не поднимай конструкцию выше уровня глаз.',
      'Измени только форму одной опоры и сравни, стала ли башня устойчивее.',
    ],
    ageBands: ['8_10', '11_12', '13_14'],
  },
];

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function seedResearchContent(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO research.policy_versions(id,active,kill_epoch,effective_at)
     VALUES($1,true,1,'2026-09-14T00:00:00Z')
     ON CONFLICT(id) DO UPDATE SET active=EXCLUDED.active
     WHERE research.policy_versions.kill_epoch=1`,
    [RESEARCH_POLICY],
  );
  for (const challenge of curatedChallenges) {
    const hash = contentHash(challenge);
    const result = await client.query<{ content_hash: string }>(
      `INSERT INTO research.challenge_versions(
        id,key,version,kind,title,goal,duration_minutes,resume_window_minutes,materials,steps,age_bands,
        risk_class,supervision_requirement,origin,distribution_scope,status,
        policy_version,content_hash,reviewed_by,published_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        'MINIMAL_RISK','NONE','CURATED','CATALOG','PUBLISHED',$12,$13,$14,$15)
       ON CONFLICT(key,version) DO UPDATE SET key=EXCLUDED.key
       RETURNING content_hash`,
      [
        challenge.id,
        challenge.key,
        challenge.version,
        challenge.kind,
        challenge.title,
        challenge.goal,
        challenge.durationMinutes,
        challenge.resumeWindowMinutes,
        JSON.stringify(challenge.materials),
        JSON.stringify(challenge.steps),
        JSON.stringify(challenge.ageBands),
        RESEARCH_POLICY,
        hash,
        'internal-synthetic-content-review-2026-09-15',
        '2026-09-15T00:00:00Z',
      ],
    );
    if (result.rows[0]?.content_hash !== hash)
      throw new Error(`Curated challenge ${challenge.key}@${challenge.version} hash mismatch.`);
  }
}
