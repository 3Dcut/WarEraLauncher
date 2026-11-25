// Texte für Einstellungen, Themes, Befehlspalette, Hilfe und Tastenkürzel. Schlüssel beginnen mit "settings.".
import { defineMessages } from '../define';

export default defineMessages({
  de: {
    'settings.language': 'Sprache',
    'settings.languageAuto': 'Automatisch',
    'settings.languageHint': 'Mit ?lang=de, ?lang=en oder ?lang=sv in der Adresse lässt sich die Sprache auch per Link festlegen.',
  },
  en: {
    'settings.language': 'Language',
    'settings.languageAuto': 'Automatic',
    'settings.languageHint': 'Add ?lang=de, ?lang=en or ?lang=sv to the address to set the language via a link.',
  },
  sv: {
    'settings.language': 'Språk',
    'settings.languageAuto': 'Automatiskt',
    'settings.languageHint': 'Lägg till ?lang=de, ?lang=en eller ?lang=sv i adressen för att välja språk via en länk.',
  },
});
