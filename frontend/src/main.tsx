// @ts-nocheck
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PolyDashboard from './PolyDashboard'
import ErrorBoundary from './ErrorBoundary'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <PolyDashboard />
    </ErrorBoundary>
  </StrictMode>,
)
