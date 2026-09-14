import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';

// shadcn/ui radix-nova Alert, адаптирован под токены «Пробую».
// role задаётся потребителем: `alert` только для внезапной ошибки, иначе `status`/без роли.
const alertVariants = cva(
  'group/alert relative grid w-full gap-1 rounded-xl border px-4 py-3 text-left text-body has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-3 *:[svg]:row-span-2 *:[svg]:mt-0.5 *:[svg]:size-5 *:[svg]:text-current',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        destructive: 'border-destructive bg-card text-foreground *:[svg]:text-destructive',
        info: 'border-info bg-card text-foreground *:[svg]:text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('font-semibold group-has-[>svg]/alert:col-start-2', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-body text-muted-foreground group-has-[>svg]/alert:col-start-2 [&_p:not(:last-child)]:mb-2',
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
