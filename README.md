# DoUpload

Kunden laden angeforderte Dokumente Schritt für Schritt hoch – ein Dokument pro Seite, in 8 Sprachen.
Die Dateien gehen automatisch per E-Mail an den Berater.

- Webseite: `index.html` (GitHub Pages)
- Backend: Supabase-Projekt **DoUpload** (`keurzrtbpcefwsowtfmc`), Edge Function `api` (`supabase/functions/api/index.ts`)
- Secrets (Supabase → Edge Functions → Secrets): `RESEND_API_KEY`, optional `EMAIL_FROM`
- Empfänger registrieren sich selbst (E-Mail + Passwort); hochgeladene Dateien sind unter „Mein Bereich“ abrufbar
