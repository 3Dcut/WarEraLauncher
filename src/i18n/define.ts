/** Legt die Texte eines Bereichs an; en und sv müssen genau die Schlüssel von de haben. */
export function defineMessages<const D extends Record<string, string>>(m: {
  de: D;
  en: { [K in keyof D]: string };
  sv: { [K in keyof D]: string };
}) {
  return m;
}
