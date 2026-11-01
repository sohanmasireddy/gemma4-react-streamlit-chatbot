import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

export default function renderChatComponent({ parentElement, data }) {
  let rootElement = parentElement.querySelector('#react-chat-root');
  if (!rootElement) {
    rootElement = document.createElement('div');
    rootElement.id = 'react-chat-root';
    parentElement.appendChild(rootElement);
  }
  if (!rootElement.__reactRoot) {
    rootElement.__reactRoot = createRoot(rootElement);
  }
  rootElement.__reactRoot.render(
    <App apiBaseUrl={data?.apiBaseUrl || '__AUTO__'} model={data?.model || 'gemma4'} bridgeToken={data?.bridgeToken} />,
  );
  return () => {
    rootElement.__reactRoot?.unmount();
    rootElement.__reactRoot = null;
  };
}
