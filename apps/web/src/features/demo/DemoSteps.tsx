import type { DemoScenario } from '@probyu/contracts';
import { Button } from '@probyu/ui/components/button';
import { RadioGroup, RadioGroupItem } from '@probyu/ui/components/radio-group';
import { ArrowLeft, ArrowRight, Info, ShieldCheck } from 'lucide-react';
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Link } from 'react-router-dom';

import { formatMinutes } from './format';
import { neighbourStep, type DemoChoices, type DemoStepId } from './steps';

type StepProps = {
  scenario: DemoScenario;
  choices: DemoChoices;
  onChoicesChange: (update: (current: DemoChoices) => DemoChoices) => void;
  go: (step: DemoStepId) => void;
  onRestart: () => void;
  headingRef: Ref<HTMLHeadingElement>;
};

export function DemoStepScreen({ step, ...props }: StepProps & { step: DemoStepId }) {
  switch (step) {
    case 'question':
      return <QuestionStep {...props} />;
    case 'explanation':
      return <ExplanationStep {...props} />;
    case 'probe':
      return <ProbeStep {...props} />;
    case 'result':
      return <ResultStep {...props} />;
    case 'reflection':
      return <ReflectionStep {...props} />;
    case 'observation':
      return <ObservationStep {...props} />;
    case 'done':
      return <DoneStep {...props} />;
  }
}

function StepHeading({
  headingRef,
  children,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <h1 ref={headingRef} tabIndex={-1} className="step-title">
      {children}
    </h1>
  );
}

function BackButton({ from, go }: { from: DemoStepId; go: (step: DemoStepId) => void }) {
  const previous = neighbourStep(from, -1);
  if (previous === undefined) return null;
  return (
    <Button type="button" variant="ghost" size="lg" onClick={() => go(previous)}>
      <ArrowLeft aria-hidden="true" />
      Назад
    </Button>
  );
}

function QuestionStep({ scenario, go, headingRef }: StepProps) {
  return (
    <div className="question-layout">
      <div className="question-layout__main">
        <StepHeading headingRef={headingRef}>{scenario.question}</StepHeading>
        <dl className="spec-list">
          <div>
            <dt>Проба</dt>
            <dd>около {formatMinutes(scenario.probe.durationMinutes)}</dd>
          </div>
          <div>
            <dt>Весь пример</dt>
            <dd>около {formatMinutes(scenario.durationMinutes)}</dd>
          </div>
          <div>
            <dt>Возраст</dt>
            <dd>{scenario.ageBand} лет</dd>
          </div>
        </dl>
        <div className="action-row">
          <Button size="lg" onClick={() => go('explanation')}>
            Узнать почему
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </div>
      <DropGauge />
    </div>
  );
}

/** Схема будущей пробы: два листа на одной высоте над полом. Исход не показывается заранее. */
function DropGauge() {
  return (
    <figure className="drop-gauge">
      <div className="drop-gauge__scale" aria-hidden="true">
        <span className="drop-gauge__mark drop-gauge__mark--top">у плеч</span>
        <span className="drop-gauge__mark drop-gauge__mark--floor">пол</span>
        <div className="drop-gauge__lane">
          <span className="drop-gauge__sheet drop-gauge__sheet--flat" />
          <span className="drop-gauge__lane-label">плоский</span>
        </div>
        <div className="drop-gauge__lane">
          <span className="drop-gauge__sheet drop-gauge__sheet--crumpled" />
          <span className="drop-gauge__lane-label">смятый</span>
        </div>
      </div>
      <figcaption className="drop-gauge__caption">
        Два одинаковых листа на одной высоте. Какой коснётся пола первым?
      </figcaption>
    </figure>
  );
}

function ExplanationStep({ scenario, go, headingRef }: StepProps) {
  return (
    <div className="step-stack">
      <StepHeading headingRef={headingRef}>Почему так происходит</StepHeading>
      <ol className="cause-chain">
        {scenario.explanation.map((sentence, index) => (
          <li
            key={sentence}
            className="cause-chain__item"
            style={{ '--i': index } as CSSProperties}
          >
            {sentence}
          </li>
        ))}
      </ol>
      <p className="step-note">
        <Info aria-hidden="true" className="size-5 shrink-0" />
        Текст примера подготовлен заранее. Объяснение можно проверить самому: для этого и нужна
        проба.
      </p>
      <div className="action-row">
        <Button size="lg" onClick={() => go('probe')}>
          К пробе
          <ArrowRight aria-hidden="true" />
        </Button>
        <BackButton from="explanation" go={go} />
      </div>
    </div>
  );
}

function ProbeStep({ scenario, go, headingRef }: StepProps) {
  const { probe } = scenario;
  return (
    <div className="step-stack">
      <div>
        <StepHeading headingRef={headingRef}>{probe.goal}</StepHeading>
        <p className="step-meta">Займёт около {formatMinutes(probe.durationMinutes)}</p>
      </div>

      <section className="safety-block" aria-labelledby="safety-heading">
        <h2 id="safety-heading" className="block-title">
          <ShieldCheck aria-hidden="true" className="size-6 shrink-0" />
          Сначала безопасность
        </h2>
        <ul className="plain-list">
          {probe.safetyNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="materials-heading">
        <h2 id="materials-heading" className="block-title">
          Понадобится
        </h2>
        <ul className="plain-list">
          {probe.materials.map((material) => (
            <li key={material}>{material}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="steps-heading">
        <h2 id="steps-heading" className="block-title">
          Как проводить
        </h2>
        <ol className="probe-steps">
          {probe.steps.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>
      </section>

      <p className="step-note">
        <Info aria-hidden="true" className="size-5 shrink-0" />В примере пробу можно не проводить
        по-настоящему. Дальше ты выберешь один из готовых вариантов результата.
      </p>

      <div className="action-row">
        <Button size="lg" onClick={() => go('result')}>
          Отметить результат
          <ArrowRight aria-hidden="true" />
        </Button>
        <BackButton from="probe" go={go} />
      </div>
    </div>
  );
}

type ChoiceListProps = {
  name: string;
  options: { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
  labelledBy: string;
  describedBy: string;
  invalid: boolean;
};

function ChoiceList({
  name,
  options,
  value,
  onValueChange,
  labelledBy,
  describedBy,
  invalid,
}: ChoiceListProps) {
  const baseId = useId();
  return (
    <RadioGroup
      name={name}
      value={value}
      onValueChange={onValueChange}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className="choice-list"
    >
      {options.map((option, index) => {
        const id = `${baseId}-${String(index)}`;
        return (
          <label key={option.value} htmlFor={id} className="choice-row">
            <RadioGroupItem id={id} value={option.value} aria-invalid={invalid || undefined} />
            <span>{option.label}</span>
          </label>
        );
      })}
    </RadioGroup>
  );
}

function ResultStep({ scenario, choices, onChoicesChange, go, headingRef }: StepProps) {
  const [selected, setSelected] = useState(choices.resultId ?? '');
  const [confirmedId, setConfirmedId] = useState(choices.resultId);
  const [showError, setShowError] = useState(false);
  const feedbackRef = useRef<HTMLElement>(null);
  const confirmed = scenario.resultOptions.find(
    (option) => option.id === confirmedId && option.id === selected,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected === '') {
      setShowError(true);
      return;
    }
    setShowError(false);
    setConfirmedId(selected);
    onChoicesChange((current) => ({ ...current, resultId: selected }));
    requestAnimationFrame(() => feedbackRef.current?.focus());
  };

  return (
    <form className="step-stack" onSubmit={submit} noValidate>
      <div>
        <StepHeading headingRef={headingRef}>
          <span id="result-heading">Что получилось?</span>
        </StepHeading>
        <p id="result-hint" className="step-meta">
          Выбери вариант, который ближе всего к твоему наблюдению.
        </p>
      </div>
      <ChoiceList
        name="result"
        options={scenario.resultOptions.map((option) => ({
          value: option.id,
          label: option.label,
        }))}
        value={selected}
        onValueChange={(value) => {
          setSelected(value);
          setConfirmedId(undefined);
          setShowError(false);
          onChoicesChange(() => ({}));
        }}
        labelledBy="result-heading"
        describedBy={showError ? 'result-hint result-error' : 'result-hint'}
        invalid={showError}
      />
      {showError && (
        <p id="result-error" className="field-error" role="alert">
          Выбери один из вариантов.
        </p>
      )}

      {confirmed === undefined ? (
        <div className="action-row">
          <Button type="submit" size="lg">
            Показать отклик
          </Button>
          <BackButton from="result" go={go} />
        </div>
      ) : (
        <section
          ref={feedbackRef}
          tabIndex={-1}
          className="feedback-block"
          aria-labelledby="feedback-heading"
        >
          <h2 id="feedback-heading" className="block-title">
            Отклик на твой выбор
          </h2>
          <p className="text-child">{confirmed.feedback}</p>
          <p className="source-note">
            Это твоё сообщение о результате. Приложение не видит, что происходило на самом деле.
          </p>
          <div className="action-row">
            <Button type="button" size="lg" onClick={() => go('reflection')}>
              Дальше
              <ArrowRight aria-hidden="true" />
            </Button>
            <BackButton from="result" go={go} />
          </div>
        </section>
      )}
    </form>
  );
}

function ReflectionStep({ scenario, choices, onChoicesChange, go, headingRef }: StepProps) {
  const initial = choices.reflection?.kind === 'answered' ? choices.reflection.option : '';
  const [selected, setSelected] = useState(initial);
  const [showError, setShowError] = useState(false);

  const answer = (event: FormEvent) => {
    event.preventDefault();
    if (selected === '') {
      setShowError(true);
      return;
    }
    onChoicesChange((current) => ({
      ...current,
      reflection: { kind: 'answered', option: selected },
    }));
    go('observation');
  };

  const skip = () => {
    onChoicesChange((current) => ({ ...current, reflection: { kind: 'skipped' } }));
    go('observation');
  };

  return (
    <form className="step-stack" onSubmit={answer} noValidate>
      <div>
        <StepHeading headingRef={headingRef}>
          <span id="reflection-heading">{scenario.reflection.prompt}</span>
        </StepHeading>
        <p id="reflection-hint" className="step-meta">
          Ответь, если хочется. Пропустить тоже можно, это ничего не портит.
        </p>
      </div>
      <ChoiceList
        name="reflection"
        options={scenario.reflection.options.map((option) => ({ value: option, label: option }))}
        value={selected}
        onValueChange={(value) => {
          setSelected(value);
          setShowError(false);
          onChoicesChange((current) =>
            current.resultId === undefined ? {} : { resultId: current.resultId },
          );
        }}
        labelledBy="reflection-heading"
        describedBy={showError ? 'reflection-hint reflection-error' : 'reflection-hint'}
        invalid={showError}
      />
      {showError && (
        <p id="reflection-error" className="field-error" role="alert">
          Выбери вариант или нажми «Пропустить».
        </p>
      )}
      <div className="action-row">
        <Button type="submit" size="lg">
          Ответить
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={skip}>
          Пропустить
        </Button>
        <BackButton from="reflection" go={go} />
      </div>
    </form>
  );
}

function ObservationStep({ scenario, choices, go, headingRef }: StepProps) {
  const result = scenario.resultOptions.find((option) => option.id === choices.resultId);
  const reflection = choices.reflection;

  return (
    <div className="step-stack">
      <StepHeading headingRef={headingRef}>Что показал этот эпизод</StepHeading>

      <div className="episode-sheet">
        <section className="episode-row" aria-labelledby="episode-report">
          <h2 id="episode-report" className="episode-row__label">
            Твоё сообщение
          </h2>
          <div className="episode-row__body">
            <p className="text-child">{result?.label}</p>
            <p className="text-body text-muted-foreground">
              {reflection?.kind === 'answered'
                ? `Ответ на вопрос «${scenario.reflection.prompt}»: ${reflection.option}`
                : 'Рефлексия пропущена'}
            </p>
            <p className="source-note">
              Источник: твой выбор в этом примере, а не проверка действия.
            </p>
          </div>
        </section>

        <section className="episode-row" aria-labelledby="episode-observation">
          <h2 id="episode-observation" className="episode-row__label">
            Наблюдение
          </h2>
          <div className="episode-row__body">
            <p className="text-child">{scenario.observation.label}</p>
            <p className="status-tag">Пока мало наблюдений</p>
          </div>
        </section>

        <section className="episode-row" aria-labelledby="episode-limits">
          <h2 id="episode-limits" className="episode-row__label">
            Ограничение
          </h2>
          <div className="episode-row__body">
            <p className="text-child">{scenario.observation.limits}</p>
            <p className="source-note">В демонстрации этот эпизод нигде не сохраняется.</p>
          </div>
        </section>
      </div>

      <div className="action-row">
        <Button size="lg" onClick={() => go('done')}>
          Завершить
          <ArrowRight aria-hidden="true" />
        </Button>
        <BackButton from="observation" go={go} />
      </div>
    </div>
  );
}

function DoneStep({ scenario, onRestart, headingRef }: StepProps) {
  const { completion } = scenario;

  return (
    <div className="step-stack">
      <div>
        <StepHeading headingRef={headingRef}>{completion.title}</StepHeading>
        <p className="step-lead">{completion.body}</p>
      </div>
      <div className="action-row">
        <Button asChild size="lg">
          <Link to="/">{completion.cta}</Link>
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={onRestart}>
          Пройти пример ещё раз
        </Button>
      </div>
      <section className="adult-aside" aria-labelledby="adult-aside-heading">
        <h2 id="adult-aside-heading" className="block-title">
          Для взрослых
        </h2>
        <p>
          Свои вопросы и сохранённые исследования появятся после того, как взрослый активирует
          семейный доступ. В этой демонстрации такой возможности пока нет.
        </p>
      </section>
    </div>
  );
}
