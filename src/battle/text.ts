// Übersetzte Bezeichnungen für Seltenheiten, Items, Werte und Kistentypen.
// Die Logik kennt nur Codes; Namen kommen aus dem Wörterbuch (src/i18n/messages/battle.ts).

import { t, formatNumber, type MessageKey } from '../i18n';
import { caseType, itemInfo, SKILLS, type Rarity, type Side, type Valuation } from './logic';

const key = (k: string) => k as MessageKey;

export function rarityLabel(rarity: Rarity | null | undefined): string {
  return t(key(rarity ? `battle.rarity.${rarity}` : 'battle.rarity.unknown'));
}

export function itemName(code: string): string {
  const base = itemInfo(code).base;
  return base ? t(key(`battle.item.${base}`)) : code;
}

export function skillsText(skills: Record<string, number> | undefined): string {
  if (!skills) return '';
  return Object.entries(skills)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${SKILLS.includes(k) ? t(key(`battle.skill.${k}`)) : k} ${v}`)
    .join(' · ');
}

export function caseLabel(code: string | null | undefined): string {
  return t(key(`battle.case.${caseType(code).key}`));
}

export function sideLabel(side: Side): string {
  return t(side === 0 ? 'battle.side.0' : 'battle.side.1');
}

/** Geldbetrag im Spiel, zwei Nachkommastellen; ab 1000 ohne. */
export function money(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Bilanz mit Vorzeichen (+12,40 / −37,30). */
export function signedMoney(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'exceptZero' }).replace('-', '−');
}

/** Woher eine Schätzung stammt, für Tooltips. */
export function valueBasis(v: Valuation | null | undefined): string {
  if (v === null) return t('battle.value.none');
  if (!v) return t('battle.value.pending');
  return t(key(`battle.value.${v.basis}`));
}
