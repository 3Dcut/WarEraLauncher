import { render } from 'preact';
import { bootPage } from '../assist/page';
import { CasesApp } from './CasesApp';
import { resumeSession, setKey, watchMarket } from './engine';
import { apiKey } from '../core/apiKey';

bootPage('cases.title', 'cases.docDescription');

// ?demo=1 startet eine Demo mit den Quoten beider Kisten; ?lang=de|en|sv wählt die Sprache wie im Launcher
const demo = new URLSearchParams(location.search).get('demo') === '1';
setKey(apiKey.value || null);
if (!demo) resumeSession(apiKey.value || null);
watchMarket();

const root = document.getElementById('app')!;
root.textContent = '';
render(<CasesApp demo={demo} />, root);
