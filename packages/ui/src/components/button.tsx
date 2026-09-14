import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '../lib/utils';

// shadcn/ui radix-nova Button, адаптирован под токены «Пробую»:
// минимум 44px (главное действие 48px), фокус 2px + отступ 2px, отклик нажатия scale(0.97).
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent font-semibold whitespace-nowrap select-none transition-[transform,background-color,border-color,color] duration-150 ease-out outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-disabled:scale-[0.97] disabled:pointer-events-none disabled:opacity-60 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline:
          'border-input bg-card text-foreground hover:border-foreground hover:bg-secondary aria-expanded:bg-secondary',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'text-foreground hover:bg-secondary aria-expanded:bg-secondary',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-[color-mix(in_oklab,var(--destructive),black_12%)]',
        link: 'h-auto min-h-11 px-0 text-primary underline underline-offset-4 hover:text-primary-hover',
      },
      size: {
        default: 'min-h-11 px-4 text-body',
        lg: 'min-h-12 px-6 text-child',
        sm: 'min-h-11 px-3 text-caption',
        icon: 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
