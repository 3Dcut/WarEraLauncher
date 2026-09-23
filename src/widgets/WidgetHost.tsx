import { useRef } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import type { WidgetKind } from '../data/tools';
import { TimersWidget } from './Timers';
import { CharacterWidget } from './Character';
import { MarketWidget } from './Market';
import { BattlesWidget } from './Battles';
import { RadioConsole } from '../ui/RadioConsole';

export function WidgetHost({ kind, visible }: { kind: WidgetKind; visible: Signal<boolean> }) {
  const prefix = useRef(`w-${Math.random().toString(36).slice(2, 6)}`);
  return (
    <div class={`widget widget--${kind}`}>
      {kind === 'timers' && <TimersWidget />}
      {kind === 'character' && <CharacterWidget visible={visible} />}
      {kind === 'market' && <MarketWidget visible={visible} />}
      {kind === 'battles' && <BattlesWidget visible={visible} />}
      {kind === 'radio' && <RadioConsole idPrefix={prefix.current} />}
    </div>
  );
}
