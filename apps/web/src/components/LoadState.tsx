import { Alert, AlertDescription, AlertTitle } from '@probyu/ui/components/alert';
import { Button } from '@probyu/ui/components/button';
import { RotateCw, TriangleAlert, WifiOff } from 'lucide-react';
import type { Ref } from 'react';
import { Link } from 'react-router-dom';

import type { DemoLoadErrorKind } from '../features/demo/api';

const COPY: Record<DemoLoadErrorKind, { title: string; body: string }> = {
  network: {
    title: 'Нет связи с сервером',
    body: 'Пример загружается из сети. Проверь подключение и попробуй ещё раз.',
  },
  unavailable: {
    title: 'Сервер сейчас не отвечает',
    body: 'Мы не показываем пример по памяти или придуманный текст. Попробуй ещё раз чуть позже.',
  },
  invalid: {
    title: 'Пример пришёл неполным',
    body: 'Чтобы не показать ошибку, мы остановились. Попробуй загрузить его ещё раз.',
  },
  'not-found': {
    title: 'Такого примера нет',
    body: 'Возможно, ссылка устарела. Вернись в начало и выбери пример оттуда.',
  },
};

type LoadErrorProps = {
  kind: DemoLoadErrorKind;
  retrying: boolean;
  onRetry: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Уровень заголовка: h1 на экране шага, h2 внутри страницы. */
  headingLevel?: 1 | 2;
};

export function LoadError({
  kind,
  retrying,
  onRetry,
  headingRef,
  headingLevel = 1,
}: LoadErrorProps) {
  const copy = COPY[kind];
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const canRetry = kind !== 'not-found';

  return (
    <div className="load-error">
      <Alert variant="destructive" role="alert">
        {kind === 'network' ? <WifiOff aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        <AlertTitle>
          <Heading ref={headingRef} tabIndex={-1} className="text-title-sm font-semibold">
            {copy.title}
          </Heading>
        </AlertTitle>
        <AlertDescription>
          <p>{copy.body}</p>
        </AlertDescription>
      </Alert>
      <div className="action-row">
        {canRetry && (
          <Button size="lg" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
            <RotateCw aria-hidden="true" className={retrying ? 'spin-while-busy' : undefined} />
            {retrying ? 'Пробуем снова' : 'Повторить'}
          </Button>
        )}
        <Button asChild variant={canRetry ? 'ghost' : 'default'} size="lg">
          <Link to="/">В начало</Link>
        </Button>
      </div>
    </div>
  );
}
