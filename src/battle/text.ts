// Übersetzte Bezeichnungen für Seltenheiten, Items, Werte und Kistentypen.
// Die Logik kennt nur Codes; Namen kommen aus dem Wörterbuch (src/i18n/messages/battle.ts).

import { t, type MessageKey } from '../i18n';
import { caseType, itemInfo, SKILLS, type Rarity, type Side } from './logic';

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

export function caseText(code: string | null | undefined, kind: 'name' | 'short' | 'plural'): string {
  return t(key(`battle.case.${caseType(code).key}.${kind}`));
}

export function sideLabel(side: Side): string {
  return t(side === 0 ? 'battle.side.0' : 'battle.side.1');
}
