import { Skeleton } from '@probyu/ui/components/skeleton';
import { X } from 'lucide-react';
import { startTransition, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import { AppShell } from '../../components/AppShell';
import { LoadError } from '../../components/LoadState';
import { errorKind, useDemoScenario } from './api';
import { DemoStepScreen } from './DemoSteps';
import { MeasureRail } from './MeasureRail';
import {
  demoStepPath,
  furthestReachableIndex,
  isDemoStepId,
  missingChoiceStep,
  stepIndex,
  stepLabel,
  type DemoChoices,
  type DemoStepId,
} from './steps';

type RedirectState = { choicesLost?: boolean } | null;

export function DemoFlowRoute() {
  const { scenarioId = '' } = useParams();
  // Новый сценарий получает чистое состояние выборов.
  return <DemoFlow key={scenarioId} scenarioId={scenarioId} />;
}

function DemoFlow({ scenarioId }: { scenarioId: string }) {
  const { step } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const scenario = useDemoScenario(scenarioId);
  const [choices, setChoices] = useState<DemoChoices>({});
  const [maxVisited, setMaxVisited] = useState(() => (isDemoStepId(step) ? stepIndex(step) : 0));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const currentStep: DemoStepId | undefined = isDemoStepId(step) ? step : undefined;
  const missing = currentStep === undefined ? undefined : missingChoiceStep(currentStep, choices);
  const activeStep = missing === undefined ? currentStep : undefined;

  useEffect(() => {
    if (activeStep === undefined) return;
    const title = scenario.data?.title;
    document.title = [stepLabel(activeStep), title, 'Пробую'].filter(Boolean).join(' | ');
  }, [activeStep, scenario.data?.title]);

  useEffect(() => {
    if (activeStep === undefined) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // Переход шага: новый экран начинается сверху, фокус на его заголовке.
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [activeStep]);

  if (currentStep === undefined) {
    return <Navigate to={demoStepPath(scenarioId, 'question')} replace />;
  }
  if (missing !== undefined) {
    return (
      <Navigate
        to={demoStepPath(scenarioId, missing)}
        replace
        state={{ choicesLost: true } satisfies RedirectState}
      />
    );
  }

  const go = (target: DemoStepId) => {
    setMaxVisited((value) => Math.max(value, stepIndex(target)));
    void navigate(demoStepPath(scenarioId, target));
  };
  const restart = () => {
    // Сброс выборов и переход коммитятся вместе, иначе guard успеет увести на «Результат».
    startTransition(() => {
      setChoices({});
      setMaxVisited(0);
      void navigate(demoStepPath(scenarioId, 'question'));
    });
  };
  const choicesLost =
    (location.state as RedirectState)?.choicesLost === true &&
    ((currentStep === 'result' && choices.resultId === undefined) ||
      (currentStep === 'reflection' && choices.reflection === undefined));
  const linkableUntil = Math.min(maxVisited, furthestReachableIndex(choices));

  return (
    <AppShell
      context={scenario.data?.title}
      headerAction={
        <Link to="/" className="exit-link" aria-label="Выйти из примера">
          <X aria-hidden="true" className="size-5" />
          <span>
            Выйти<span className="exit-link__rest"> из примера</span>
          </span>
        </Link>
      }
    >
      <div className="flow-layout">
        <MeasureRail scenarioId={scenarioId} current={currentStep} linkableUntil={linkableUntil} />
        <div className="flow-content">
          {choicesLost && (
            <p className="flow-notice" role="status">
              После обновления страницы выборы не сохраняются. Отметь этот шаг ещё раз.
            </p>
          )}
          {scenario.isPending && <StepSkeleton />}
          {scenario.isError && (
            <LoadError
              kind={errorKind(scenario.error)}
              retrying={scenario.isFetching}
              onRetry={() => void scenario.refetch()}
              headingRef={headingRef}
            />
          )}
          {scenario.isSuccess && (
            <div key={currentStep} className="step-enter">
              <DemoStepScreen
                step={currentStep}
                scenario={scenario.data}
                choices={choices}
                onChoicesChange={setChoices}
                go={go}
                onRestart={restart}
                headingRef={headingRef}
              />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function StepSkeleton() {
  return (
    <div className="step-skeleton" role="status">
      <span className="sr-only">Загружаем пример</span>
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-10 w-3/4 max-w-lg" />
      <Skeleton className="mt-4 h-5 w-64" />
      <Skeleton className="mt-8 h-12 w-48" />
    </div>
  );
}
