# Fonts

## MICR E-13B font (required for check printing)

Drop a MICR E-13B TrueType font file here named **`micr.ttf`**.

The dashboard's check-printing feature loads `/fonts/micr.ttf` and embeds it into
the generated PDFs, so no font install is needed on the printing machine.

### Recommended: GnuMICR

- Source: https://sourceforge.net/projects/gnumicr/
- License: GPL (fine for internal tool use)
- Character mapping used by the dashboard:
  - `A` → Transit symbol (⑆)
  - `C` → On-Us symbol (⑈)

If you use a different MICR font, the character mapping may differ — update the
`MICR_CHARS` constant in `ark-dashboard.html` (search for it) to match.

### IMPORTANT — Verify before batch printing

Before printing a full batch, print **one test check** and:
1. Confirm MICR line position is ~5/8" from the bottom edge of the check portion
2. Run it through your bank's deposit workflow (or ask a teller to scan it)
3. If it scans cleanly, you're good. Alignment is stable once verified.
