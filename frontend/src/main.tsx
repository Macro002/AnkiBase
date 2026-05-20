import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
// Set theme-color via JS so it's immune to HTML caching
const metaTheme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
if (metaTheme) metaTheme.content = '#16213e';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
