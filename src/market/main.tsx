import { render } from 'preact';
import { bootPage } from '../assist/page';
import { MarketApp } from './MarketApp';

bootPage('market.title', 'market.docDescription');

const root = document.getElementById('app')!;
root.textContent = '';
render(<MarketApp />, root);
