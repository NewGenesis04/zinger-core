// @ts-nocheck
import { Component } from 'react'

/**
 * Top-level error boundary.
 *
 * Without one, React unmounts the whole tree on an uncaught render error and
 * `#root` is left empty — which, with the black background index.html paints,
 * shows as a blank page and nothing else. A live-money terminal must never fail
 * that quietly: an operator cannot tell "crashed" from "still loading" from
 * "logged out", and the only way to find out is DevTools.
 *
 * This renders the error and the component stack on screen instead. The stack
 * is what actually names the failing component, so it is shown by default
 * rather than hidden behind a toggle.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ error, info })
    // Also to the console, so a copy survives if the operator navigates away.
    console.error('[zinger] render crash', error, info?.componentStack)
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    const box = {
      font: '13px/1.55 ui-monospace, "SF Mono", Menlo, monospace',
      background: '#0b0d10',
      color: '#e8eaed',
      minHeight: '100dvh',
      margin: 0,
      padding: '28px',
      boxSizing: 'border-box',
    }
    const pre = {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      background: '#14171c',
      border: '1px solid #2a2f38',
      borderRadius: '6px',
      padding: '14px 16px',
      margin: '0 0 18px',
      maxHeight: '42vh',
      overflow: 'auto',
    }

    return (
      <div style={box}>
        <div style={{ color: '#ff8a7a', fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>
          Zinger UI crashed
        </div>
        <div style={{ color: '#9aa3b2', marginBottom: '18px' }}>
          The dashboard threw during render. The bot process is unaffected — this is the
          browser only.
        </div>

        <div style={{ color: '#9aa3b2', marginBottom: '6px' }}>Error</div>
        <pre style={pre}>{String(error?.stack || error?.message || error)}</pre>

        {info?.componentStack && (
          <>
            <div style={{ color: '#9aa3b2', marginBottom: '6px' }}>Component stack</div>
            <pre style={pre}>{info.componentStack}</pre>
          </>
        )}

        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            font: 'inherit',
            background: '#1d2530',
            color: '#e8eaed',
            border: '1px solid #33404f',
            borderRadius: '6px',
            padding: '8px 14px',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
