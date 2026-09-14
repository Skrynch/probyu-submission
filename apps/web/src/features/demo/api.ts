import {
  getDemoScenario,
  listDemoScenarios,
  type DemoScenario,
  type DemoScenarioSummary,
} from '@probyu/contracts';
import { useQuery } from '@tanstack/react-query';

export type DemoLoadErrorKind = 'network' | 'not-found' | 'unavailable' | 'invalid';

export class DemoLoadError extends Error {
  constructor(readonly kind: DemoLoadErrorKind) {
    super(`Demo content failed to load: ${kind}`);
    this.name = 'DemoLoadError';
  }
}

const SCENARIO_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

type SdkResult = { data?: unknown; error?: unknown; response?: Response };

function classify(result: SdkResult): DemoLoadError | undefined {
  // Сетевая ошибка fetch возвращается генерированным клиентом без response.
  if (result.response === undefined) return new DemoLoadError('network');
  if (result.response.status === 404) return new DemoLoadError('not-found');
  if (!result.response.ok || result.error !== undefined) return new DemoLoadError('unavailable');
  return undefined;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTextList = (value: unknown, min: number): value is string[] =>
  Array.isArray(value) && value.length >= min && value.every(isText);

// Минимальная runtime-проверка формы ответа: типы SDK не защищают UI от неполного payload.
// Это проверка инвариантов показа, а не вторая копия DTO.
function isRenderableScenario(value: unknown): value is DemoScenario {
  if (value === null || typeof value !== 'object') return false;
  const scenario = value as Partial<DemoScenario>;
  return (
    scenario.kind === 'FIXED_DEMO' &&
    isText(scenario.id) &&
    isText(scenario.question) &&
    isTextList(scenario.explanation, 1) &&
    scenario.probe !== undefined &&
    isText(scenario.probe.goal) &&
    isTextList(scenario.probe.materials, 1) &&
    isTextList(scenario.probe.steps, 1) &&
    isTextList(scenario.probe.safetyNotes, 1) &&
    Array.isArray(scenario.resultOptions) &&
    scenario.resultOptions.length >= 2 &&
    scenario.resultOptions.every(
      (option) => isText(option.id) && isText(option.label) && isText(option.feedback),
    ) &&
    scenario.reflection !== undefined &&
    isText(scenario.reflection.prompt) &&
    isTextList(scenario.reflection.options, 2) &&
    scenario.observation !== undefined &&
    isText(scenario.observation.label) &&
    isText(scenario.observation.limits) &&
    scenario.completion !== undefined &&
    isText(scenario.completion.title) &&
    isText(scenario.completion.body) &&
    isText(scenario.completion.cta)
  );
}

function shouldRetry(failureCount: number, error: Error): boolean {
  const transient =
    error instanceof DemoLoadError && (error.kind === 'network' || error.kind === 'unavailable');
  return transient && failureCount < 1;
}

export function isValidScenarioId(scenarioId: string): boolean {
  return SCENARIO_ID_PATTERN.test(scenarioId);
}

export function useDemoScenarios() {
  return useQuery<DemoScenarioSummary[], Error>({
    queryKey: ['demo', 'scenarios'],
    queryFn: async ({ signal }) => {
      const result = await listDemoScenarios({ signal });
      const failure = classify(result);
      if (failure !== undefined) throw failure;
      const items = result.data?.items;
      if (!Array.isArray(items)) throw new DemoLoadError('invalid');
      return items;
    },
    retry: shouldRetry,
    // Опубликованная версия примера неизменна: фоновое обновление не нужно и не должно сменить экран на ошибку.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useDemoScenario(scenarioId: string) {
  const validId = isValidScenarioId(scenarioId);
  return useQuery<DemoScenario, Error>({
    queryKey: ['demo', 'scenario', scenarioId],
    queryFn: async ({ signal }) => {
      if (!validId) throw new DemoLoadError('not-found');
      const result = await getDemoScenario({ path: { scenarioId }, signal });
      const failure = classify(result);
      if (failure !== undefined) throw failure;
      if (!isRenderableScenario(result.data)) throw new DemoLoadError('invalid');
      return result.data;
    },
    retry: shouldRetry,
    // Опубликованная версия примера неизменна: фоновое обновление не нужно и не должно сменить экран на ошибку.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function errorKind(error: Error | null): DemoLoadErrorKind {
  return error instanceof DemoLoadError ? error.kind : 'unavailable';
}
