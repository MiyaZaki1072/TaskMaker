# Fonts embedded in this project

Every file in this folder is loaded locally (via `@font-face` in `assets/style.css`) —
none of them are fetched from a CDN, so preview and the PDF look identical on every machine, even offline.

| File | Font | Used for |
|---|---|---|
| `THSarabunNew.woff2` | TH Sarabun New Regular | The document's main typeface |
| `THSarabunNew-Bold.woff2` | TH Sarabun New Bold | Headings, bold text |
| `THSarabunNew-Italic.woff2` | TH Sarabun New Italic | Italic text |
| `THSarabunNew-BoldItalic.woff2` | TH Sarabun New Bold Italic | Bold italic text |
| `JetBrainsMono-Regular.woff2` | JetBrains Mono Regular | Input/output data and code |
| `JetBrainsMono-Bold.woff2` | JetBrains Mono Bold | Bold code |

## Source and license

- **TH Sarabun New** — a standard Thai government font, distributed free of charge
  (one of the 13 national fonts by Thailand's Department of Intellectual Property and SIPA).
  The files in this folder were copied from the font installed on the machine that created this repo.
  For a fresh copy, download it from the agency's website.
- **JetBrains Mono** — licensed under the SIL Open Font License 1.1 (see `JetBrainsMono-LICENSE.txt`)

Note: "TH Sarabun New" is a different font from the "Sarabun" font on Google Fonts.
