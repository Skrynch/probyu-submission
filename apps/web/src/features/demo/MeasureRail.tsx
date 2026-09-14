import { useEffect, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import { DEMO_STEPS, demoStepPath, stepIndex, type DemoStepId } from './steps';

type MeasureRailProps = {
  scenarioId: string;
  current: DemoStepId;
  /** Индексы шагов, куда можно вернуться ссылкой. */
  linkableUntil: number;
};

/**
 * Мерная лента пути: каждая отметка — шаг примера.
 * Состояние кодируется формой штриха (пройден — сплошной, текущий — длинный, впереди — пунктир),
 * а не только цветом; текущий шаг помечен aria-current.
 */
export function MeasureRail({ scenarioId, current, linkableUntil }: MeasureRailProps) {
  const currentIndex = stepIndex(current);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // На узкой ленте текущая отметка прокручивается к центру; вертикальная лента не прокручивается.
    const track = trackRef.current;
    const mark = track?.querySelector<HTMLElement>('[data-state="current"]');
    if (track === null || mark === null || mark === undefined) return;
    if (track.scrollWidth <= track.clientWidth) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollTo({
      left: mark.offsetLeft - (track.clientWidth - mark.offsetWidth) / 2,
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [currentIndex]);
  const style = { '--rail-step': currentIndex, '--rail-count': DEMO_STEPS.length } as CSSProperties;

  return (
    <nav className="measure-rail" aria-label="Путь примера" style={style}>
      <p className="measure-rail__count" aria-hidden="true">
        {currentIndex + 1} / {DEMO_STEPS.length}
      </p>
      <div ref={trackRef} className="measure-rail__track">
        <span className="measure-rail__pointer" aria-hidden="true" />
        <ol className="measure-rail__list">
          {DEMO_STEPS.map((step, index) => {
            const state =
              index < currentIndex ? 'passed' : index === currentIndex ? 'current' : 'ahead';
            const canLink = state !== 'current' && index <= linkableUntil;
            return (
              <li key={step.id} className="measure-rail__mark" data-state={state}>
                <span className="measure-rail__tick" aria-hidden="true" />
                {canLink ? (
                  <Link className="measure-rail__label" to={demoStepPath(scenarioId, step.id)}>
                    {step.label}
                  </Link>
                ) : (
                  <span
                    className="measure-rail__label"
                    aria-current={state === 'current' ? 'step' : undefined}
                  >
                    {step.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
