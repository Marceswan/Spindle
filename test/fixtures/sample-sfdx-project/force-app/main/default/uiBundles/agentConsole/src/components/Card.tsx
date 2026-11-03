import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface CardProps {
  title: string;
  children?: ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <div className={cn('card')}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
