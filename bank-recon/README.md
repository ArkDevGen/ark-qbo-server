# ARK Bank Reconciliation Tool

Local Python script for processing bank statement PDFs against a QBO GL export and producing a QBO-ready journal entry import CSV. Built for Americas Energy, generalizable to other clients.

## Setup

```powershell
# From the script folder:
pip install pdfplumber anthropic
```

If you want AI fallback for unmapped transactions, set your API key:

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

(Or pass `--no-ai` to disable.)

## Usage

```powershell
python bank_recon.py --statements .\statements --gl .\gl_export.csv --output .\output
```

### Folder layout suggestion

```
bank_recon\
  bank_recon.py
  config.json
  statements\
    BMO_2025-01.pdf
    TASI_Op_2025-01.pdf
    TASI_Payroll_2025-01.pdf
    TASI_LOC_2025-01.pdf
  gl_export.csv
  output\
    qbo_je_import.csv         <- import this to QBO
    review_report.txt         <- read this first
    review_report_detail.csv  <- full transaction-level detail
```

## Before you run

1. **Edit `config.json`** — fill in the actual last-4 digits of TASI Payroll and TASI LOC, and update the account names to match your final COA.

2. **Add the new accounts to QBO first** (TASI Payroll as Bank, TASI LOC as Other Current Liability). The JE import will fail if account names don't match exactly.

3. **Filename hints help auto-detection** — name your statement PDFs with `BMO`, `TASI_Op`, `TASI_Payroll`, `TASI_LOC` in the filename so the script auto-detects which bank account each one belongs to.

## What the script does

1. **Parses PDFs** — pdfplumber extracts each transaction line (date, description, amount).
2. **Loads GL** — builds two things from the GL export:
   - Vendor → account map (for categorization)
   - Fingerprint set (date + amount + normalized description) for duplicate detection
3. **Categorizes** in this order:
   - Duplicate check (skip if already in GL)
   - Hardcoded vendor rules (Samsara, Cox, AT&T, etc. — see `VENDOR_RULES` in script)
   - GL vendor lookup (anything you've categorized before)
   - AI fallback (Claude Sonnet) for whatever's left
4. **Outputs** a balanced JE per transaction in QBO import format + a review report.

## Reviewing output

Always read `review_report.txt` before importing. It shows:
- Summary by confidence (rule / GL match / AI / duplicate)
- Spend by account
- All duplicates (so you can verify they should be skipped)
- All AI-categorized transactions (review these — AI can be wrong)

## Extending vendor rules

When you find a vendor that keeps getting AI-categorized, add it to `VENDOR_RULES` near the top of the script. Format:

```python
(r"vendor_pattern_regex", "Account Name"),
```

First match wins, so put more specific rules above broader ones.
