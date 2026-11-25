import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import { mount } from 'svelte';
import App from './ui/App.svelte';
import { app, applyTheme } from './ui/state.svelte';

applyTheme(app.theme);

export default mount(App, { target: document.getElementById('app')! });
