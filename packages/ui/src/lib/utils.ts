import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Собственная типографическая шкала (globals.css @theme): без этого tailwind-merge
// принимает `text-child` за цвет и удаляет, например, `text-primary-foreground`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['caption', 'body', 'child', 'title-sm', 'title', 'display'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
