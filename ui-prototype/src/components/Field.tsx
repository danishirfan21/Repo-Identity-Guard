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
  /** Subtle required marker next to the label, shown instead of sprinkling "* required" everywhere. */
  required?: boolean;
  /** Extra emphasis (border + tint) used when this field was flagged as the reason a repo needs attention. */
  highlight?: boolean;
  /** Annotation styled like `highlight`'s tint rather than as an error (e.g. "Required for push verification"). */
  note?: string;
}

/** Label above a recessed input with a trailing icon (Edit Identity pattern). */
export function Field({
  label,
  icon,
  value,
  onChange,
  mono = false,
  hint,
  error,
  required = false,
  highlight = false,
  note,
  id,
  ...rest
}: FieldProps) {
  const inputId = id ?? `field-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const describedBy = error ? `${inputId}-msg` : note ? `${inputId}-note` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-label-sm text-label-sm text-on-surface-variant inline-flex items-center gap-1">
        {label}
        {required && (
          <span className="text-primary" aria-hidden="true" title="Required">
            *
          </span>
        )}
      </label>
      <div className="relative">
        <input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-required={required || undefined}
          aria-describedby={describedBy}
          className={`w-full h-8 rounded-lg bg-surface-container-lowest border pl-2.5 pr-8 text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 ${
            error ? 'border-error' : highlight ? 'border-tertiary ring-1 ring-tertiary/40' : 'border-outline-variant'
          } ${mono ? 'font-code-sm text-code-sm' : 'font-body-md text-body-md'}`}
          {...rest}
        />
        <Icon name={icon} size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
      </div>
      {error ? (
        <p id={`${inputId}-msg`} className="font-label-sm text-label-sm text-error">
          {error}
        </p>
      ) : note ? (
        <p id={`${inputId}-note`} className="font-label-sm text-label-sm text-tertiary">
          {note}
        </p>
      ) : (
        hint && (
          <p id={`${inputId}-hint`} className="font-label-sm text-label-sm text-outline">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
