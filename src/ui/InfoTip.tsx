/** Kleines ⓘ, das eine Erklärung zeigt (Hover, Tastaturfokus oder Antippen), statt Text in die Fläche zu schreiben. */
export function InfoTip({ text, label = 'Info' }: { text: string; label?: string }) {
  return (
    <button type="button" class="info-tip" aria-label={`${label}: ${text}`} onClick={(e) => (e.currentTarget as HTMLElement).focus()}>
      i<span class="info-tip__bubble" role="tooltip" aria-hidden="true">
        {text}
      </span>
    </button>
  );
}
