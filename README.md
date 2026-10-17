# Vasketid

Userscript der giver [vasketur.dk](https://web.vasketur.dk/DB0073/Default.aspx) (Electrolux web booking) et mobilvenligt udseende for beboerne i AB Mønten.

**Vejledning til beboere:** https://bettelej.github.io/vasketid/

## Sådan virker det

- Kører i brugerens egen browser via Violentmonkey (Firefox/Android) eller Userscripts (Safari/iPhone), kun på `web.vasketur.dk/DB0073/*`.
- Ingen server: scriptet sender de samme formular-postbacks som den gamle side (same-origin) og læser HTML-svarene.
- Login sendes kun til vasketur.dk. "Husk mig" er frivilligt og gemmer kun i browserens lager på telefonen.

## Filer

| Fil | Indhold |
|---|---|
| `vasketid.user.js` | Selve scriptet (auto-opdateres fra GitHub Pages) |
| `index.html` | Vejledning til beboere |
| `plakat.html` + `qr.svg` | A4-plakat med QR-kode til vaskerierne |

## Udgiv en ny version

1. Ret `vasketid.user.js` og hæv `@version`. (`vasketid.meta.js` genereres automatisk af pre-commit-hooken i `.githooks/` – kræver `git config core.hooksPath .githooks` én gang pr. klon).
2. Commit og push til `main` – GitHub Pages udgiver automatisk, og brugernes script opdaterer sig selv.

Ikke tilknyttet Electrolux eller vasketur.dk.
