export const DEMO_STEPS = [
  { id: 'question', label: 'Вопрос' },
  { id: 'explanation', label: 'Объяснение' },
  { id: 'probe', label: 'Проба' },
  { id: 'result', label: 'Результат' },
  { id: 'reflection', label: 'Рефлексия' },
  { id: 'observation', label: 'Наблюдение' },
  { id: 'done', label: 'Итог' },
] as const;

export type DemoStepId = (typeof DEMO_STEPS)[number]['id'];

export type ReflectionChoice = { kind: 'answered'; option: string } | { kind: 'skipped' };

/** Выборы живут только в памяти текущей вкладки и не отправляются на сервер. */
export type DemoChoices = {
  resultId?: string;
  reflection?: ReflectionChoice;
};

export function isDemoStepId(value: string | undefined): value is DemoStepId {
  return DEMO_STEPS.some((step) => step.id === value);
}

export function stepIndex(stepId: DemoStepId): number {
  return DEMO_STEPS.findIndex((step) => step.id === stepId);
}

export function stepLabel(stepId: DemoStepId): string {
  return DEMO_STEPS[stepIndex(stepId)]?.label ?? '';
}

export function neighbourStep(stepId: DemoStepId, offset: -1 | 1): DemoStepId | undefined {
  return DEMO_STEPS[stepIndex(stepId) + offset]?.id;
}

/** Первый шаг, который нельзя пропустить без недостающего выбора; undefined — шаг доступен. */
export function missingChoiceStep(
  stepId: DemoStepId,
  choices: DemoChoices,
): DemoStepId | undefined {
  const index = stepIndex(stepId);
  if (index > stepIndex('result') && choices.resultId === undefined) return 'result';
  if (index > stepIndex('reflection') && choices.reflection === undefined) return 'reflection';
  return undefined;
}

/** Самый дальний шаг, куда можно вернуться по ссылке шкалы. */
export function furthestReachableIndex(choices: DemoChoices): number {
  if (choices.resultId === undefined) return stepIndex('result');
  if (choices.reflection === undefined) return stepIndex('reflection');
  return DEMO_STEPS.length - 1;
}

export function demoStepPath(scenarioId: string, stepId: DemoStepId): string {
  return `/demo/${scenarioId}/${stepId}`;
}
