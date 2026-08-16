import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import OrbWidget from './components/OrbWidget'
import './index.css'

// The floating whale orb loads this same bundle with `?orb=1` into its own tiny
// transparent WebContentsView and only wants the ball, not the whole launcher.
const isOrb = new URLSearchParams(window.location.search).has('orb')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isOrb ? <OrbWidget /> : <App />}</StrictMode>
)
