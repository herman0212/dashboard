import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
const element = document.getElementById('root');
if (!element) throw new Error('Dashboard root is missing.');
createRoot(element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
