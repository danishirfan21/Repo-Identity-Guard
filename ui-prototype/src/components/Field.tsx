import type { InputHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  icon: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  hint?: ReactNode;
  error?: string;
}

/** Label above a recessed input with a trailing icon (Edit Identity pattern). */
export function Field({ label, icon, value, onChange, mono = false, hint, error, id, ...rest }: FieldProps) {
  const inputId = id ?? `field-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-label-sm text-label-sm text-on-surface-variant">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          className={`w-full h-8 rounded-lg bg-surface-container-lowest border pl-2.5 pr-8 text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 ${
            error ? 'border-error' : 'border-outline-variant'
          } ${mono ? 'font-code-sm text-code-sm' : 'font-body-md text-body-md'}`}
          {...rest}
        />
        <Icon name={icon} size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
      </div>
      {error ? (
        <p className="font-label-sm text-label-sm text-error">{error}</p>
      ) : (
        hint && <p className="font-label-sm text-label-sm text-outline">{hint}</p>
      )}
    </div>
  );
}
