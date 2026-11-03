import type { ComponentProps } from 'react'

// Adapted from Origin UI's Button + loading demo, retrieved through 21st.dev MCP.
// https://21st.dev/@originui/components/button — native CSS variant for Jamify.
export function Button({ pending = false, className = '', children, disabled, ...props }: ComponentProps<'button'> & { pending?: boolean }) {
  return <button type="button" {...props} disabled={disabled || pending} aria-busy={pending || undefined} data-loading={pending || undefined} className={`ui-button ${className}`}>
    {pending ? <><span className="ui-button-label">{children}</span><span className="ui-button-loader" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9"/></svg></span></> : children}
  </button>
}
