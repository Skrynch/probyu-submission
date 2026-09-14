import type * as React from 'react';

import { cn } from '../lib/utils';

// shadcn/ui radix-nova Skeleton; пульсация отключается глобальным prefers-reduced-motion.
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-lg bg-secondary', className)}
      {...props}
    />
  );
}

export { Skeleton };
