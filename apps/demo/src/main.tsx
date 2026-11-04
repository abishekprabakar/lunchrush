import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { TabsApp } from './ui/TabsApp';
import './styles.css';

const mode = new URLSearchParams(location.search).get('mode');
createRoot(document.getElementById('root')!).render(mode === 'tabs' ? <TabsApp /> : <App />);
