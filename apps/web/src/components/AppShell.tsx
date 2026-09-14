import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type AppShellProps = {
  children: ReactNode;
  /** Название открытого примера рядом со знаком продукта. */
  context?: string;
  headerAction?: ReactNode;
};

export function AppShell({ children, context, headerAction }: AppShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Перейти к содержанию
      </a>
      <header className="app-header">
        <div className="app-header__inner">
          <div className="app-header__brand">
            <Link to="/" className="wordmark">
              Пробую
            </Link>
            {context === undefined ? (
              <span className="app-header__context">Демонстрация</span>
            ) : (
              <span className="app-header__context">
                <span className="sr-only">Пример: </span>
                {context}
              </span>
            )}
          </div>
          {headerAction}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <p>
          Демонстрация на заранее подготовленном примере. Без аккаунта, полей ввода и аналитики.
          Выборы живут только в этой вкладке.
        </p>
      </footer>
    </div>
  );
}
