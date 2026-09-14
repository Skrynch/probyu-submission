import { Button } from '@probyu/ui/components/button';
import { Skeleton } from '@probyu/ui/components/skeleton';
import { ArrowRight } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';

import { AppShell } from '../../components/AppShell';
import { LoadError } from '../../components/LoadState';
import { errorKind, useDemoScenarios } from './api';
import { formatMinutes } from './format';
import { DEMO_STEPS, demoStepPath } from './steps';

const STEP_NOTES: Record<(typeof DEMO_STEPS)[number]['id'], string> = {
  question: 'Готовый вопрос из обычной жизни',
  explanation: 'Короткое объяснение, подготовленное заранее',
  probe: 'Безопасное действие с обычными вещами',
  result: 'Выбираешь, что получилось',
  reflection: 'Можно ответить или пропустить',
  observation: 'Что видно по одному эпизоду',
  done: 'Возвращение в начало',
};

export function DemoStart() {
  const scenarios = useDemoScenarios();

  useEffect(() => {
    document.title = 'Пробую | Демонстрация';
  }, []);

  return (
    <AppShell>
      <div className="start-layout">
        <section className="start-intro" aria-labelledby="start-heading">
          <h1 id="start-heading" className="start-title">
            Вопрос, который можно проверить руками
          </h1>
          <p className="start-lead">
            Посмотри, как Пробую превращает вопрос в короткую безопасную пробу. Это готовый пример:
            здесь ничего не нужно вводить.
          </p>
        </section>

        <section
          className="start-examples"
          aria-labelledby="examples-heading"
          aria-busy={scenarios.isPending}
        >
          <h2 id="examples-heading" className="section-title">
            Готовый пример
          </h2>
          {scenarios.isPending && (
            <div className="example-row" role="status">
              <span className="sr-only">Загружаем пример</span>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-9 w-full max-w-md" />
              <Skeleton className="h-12 w-44" />
            </div>
          )}
          {scenarios.isError && (
            <LoadError
              kind={errorKind(scenarios.error)}
              retrying={scenarios.isFetching}
              onRetry={() => void scenarios.refetch()}
              headingLevel={2}
            />
          )}
          {scenarios.isSuccess && scenarios.data.length === 0 && (
            <p className="text-child text-muted-foreground" role="status">
              Сейчас нет опубликованных примеров. Загляни позже.
            </p>
          )}
          {scenarios.isSuccess && scenarios.data.length > 0 && (
            <ul className="example-list">
              {scenarios.data.map((scenario) => (
                <li key={`${scenario.id}@${String(scenario.version)}`} className="example-row">
                  <h3 className="example-row__title">{scenario.title}</h3>
                  <p className="example-row__question">{scenario.question}</p>
                  <dl className="spec-list">
                    <div>
                      <dt>Время</dt>
                      <dd>около {formatMinutes(scenario.durationMinutes)}</dd>
                    </div>
                    <div>
                      <dt>Возраст</dt>
                      <dd>{scenario.ageBand} лет</dd>
                    </div>
                  </dl>
                  <Button asChild size="lg" className="self-start">
                    <Link
                      to={demoStepPath(scenario.id, 'question')}
                      aria-label={`Начать пример «${scenario.title}»`}
                    >
                      Начать пример
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="start-path" aria-labelledby="path-heading">
          <h2 id="path-heading" className="section-title">
            Как устроен пример
          </h2>
          <ol className="path-tape">
            {DEMO_STEPS.map((step) => (
              <li key={step.id} className="path-tape__mark">
                <span className="path-tape__tick" aria-hidden="true" />
                <span className="path-tape__label">{step.label}</span>
                <span className="path-tape__note">{STEP_NOTES[step.id]}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="start-adults" aria-labelledby="adults-heading">
          <h2 id="adults-heading" className="section-title">
            Для взрослых
          </h2>
          <div className="adult-notes">
            <p>
              Свои вопросы ребёнок сможет задавать после того, как взрослый активирует семейный
              доступ и даст согласие. В этой демонстрации такого входа пока нет.
            </p>
            <p>
              Текст примера подготовлен заранее, это не ответ AI. Демонстрация не создаёт профиль,
              не ставит cookies и не сохраняет выборы: после обновления страницы они исчезают.
            </p>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
