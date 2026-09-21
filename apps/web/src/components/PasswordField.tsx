import { InputHTMLAttributes, useState } from 'react'

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
  hint?: string
  showRequirements?: boolean
}

export function PasswordField({ label, hint, showRequirements = false, id, onKeyDown, ...inputProps }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const inputId = id ?? inputProps.name ?? 'password'

  return <label className="password-field" htmlFor={inputId}>
    <span>{label}</span>
    {hint && <small className="field-hint">{hint}</small>}
    <span className="password-control">
      <input
        {...inputProps}
        id={inputId}
        type={visible ? 'text' : 'password'}
        onKeyDown={(event) => {
          setCapsLock(event.getModifierState('CapsLock'))
          onKeyDown?.(event)
        }}
        onKeyUp={(event) => setCapsLock(event.getModifierState('CapsLock'))}
        onBlur={() => setCapsLock(false)}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        <span aria-hidden="true">{visible ? '◉' : '◌'}</span>
      </button>
    </span>
    {capsLock && <small className="caps-warning" role="status">Caps Lock is on.</small>}
    {showRequirements && <small className="field-hint">Use at least 12 characters.</small>}
  </label>
}
