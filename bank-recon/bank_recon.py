"""
ARK Bank Reconciliation Tool
============================
Processes bank statement PDFs against a GL export and produces a QBO-ready
journal entry import CSV.

Usage:
    python bank_recon.py --statements ./statements --gl ./gl_export.csv --output ./output

Inputs:
    --statements    Folder containing bank statement PDFs (BMO, TASI Op, etc.)
    --gl            QBO GL export CSV (used for vendor mapping + duplicate detection)
    --output        Folder where JE import CSV + review report will be written
    --config        Optional path to client config JSON (defaults to ./config.json)

Pipeline:
    1. Parse all PDFs in statements folder via pdfplumber
    2. Load GL: build vendor->account map + (date, amount, desc) duplicate fingerprint set
    3. For each transaction:
        a. Check duplicate fingerprint -> flag and skip if match
        b. Apply rule engine (vendor keywords -> COA accounts)
        c. If no rule match, look up in GL vendor map
        d. If still unmapped, queue for AI categorization
    4. AI batch call for unmapped transactions (Claude Sonnet)
    5. Output: JE import CSV + review report (categorized / flagged / duplicates)

Author: ARK Financial Services
"""

import argparse
import csv
import hashlib
import json
import logging
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

import pdfplumber

# ------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------

DEFAULT_CONFIG = {
    "client_name": "Americas Energy",
    "bank_accounts": {
        # Map of last-4 -> (account_number, account_name, type)
        # Will be matched against statement headers/filenames
        "6001": {"number": "10200", "name": "BMO Checking - 6001", "type": "Bank"},
        "1249": {"number": "10300", "name": "TASI - 1249",         "type": "Bank"},
        # TASI Payroll and TASI LOC will be added once we know last-4s
    },
    "ai_enabled": True,
    "ai_model": "claude-sonnet-4-20250514",
    "duplicate_strictness": "date_amount_desc",  # date_amount_desc | date_amount | strict
    "default_unmapped_account": "Ask My Accountant",
    "amex_chase_liability_account": "Chase Credit Card",  # for credit card payments
}

# Vendor categorization rules - extend as needed
# Format: (regex_pattern_or_keyword, account_name)
# Order matters - first match wins
VENDOR_RULES = [
    # ---- Fleet / Vehicle ----
    (r"samsara",                    "Fleet Management Fees"),
    (r"skybitz",                    "Fleet Management Fees"),
    (r"fuelcloud|fuel cloud",       "Fleet Management Fees"),
    (r"geotab",                     "Fleet Management Fees"),

    # ---- Telephone / Internet ----
    (r"t-mobile|t mobile",          "Telephone & Internet"),
    (r"at&t|at and t|att\b",        "Telephone & Internet"),
    (r"verizon",                    "Telephone & Internet"),
    (r"\bcox\b",                    "Telephone & Internet"),
    (r"8x8|eightxeight",            "Telephone & Internet"),
    (r"comcast|xfinity",            "Telephone & Internet"),

    # ---- Software / Subscriptions ----
    (r"microsoft|msft",             "Software & Subscriptions"),
    (r"\badt\b",                    "Software & Subscriptions"),
    (r"alert 360",                  "Software & Subscriptions"),
    (r"godaddy|go daddy",           "Software & Subscriptions"),
    (r"intuit|quickbooks|qbo",      "Software & Subscriptions"),
    (r"adobe",                      "Software & Subscriptions"),
    (r"dropbox",                    "Software & Subscriptions"),
    (r"docusign",                   "Software & Subscriptions"),
    (r"zoom\.us",                   "Software & Subscriptions"),

    # ---- Banking / Financial ----
    (r"stryker",                    "Interest Expense"),
    (r"interest charge|interest paid", "Interest Expense"),
    (r"service charge|monthly fee", "Bank Service Charges"),
    (r"wire fee|wire transfer fee", "Bank Service Charges"),
    (r"nsf fee|overdraft",          "Bank Service Charges"),

    # ---- Payroll / People ----
    (r"adp\s|adp,|gusto|paychex",   "Payroll Processing Fees"),
    (r"direct dep|payroll",         "Payroll - Wages"),

    # ---- Insurance ----
    (r"insurance|state farm|geico|progressive|nationwide",  "Insurance Expense"),

    # ---- Utilities ----
    (r"\bopg\b|electric company|power co", "Utilities"),
    (r"\bgas company|natural gas",  "Gas Utilities"),
    (r"water dept|water util",      "Utilities"),

    # ---- Credit Card payments (transfer to CC liability) ----
    (r"chase card|chase epay|chase credit", "Chase Credit Card"),
    (r"amex|american express",      "AMEX Credit Card"),

    # ---- Tax / Regulatory ----
    (r"irs|treasury",               "Tax Expense"),
    (r"dept of revenue|state tax",  "Tax Expense"),

    # ---- Meals / Travel ----
    (r"uber|lyft",                  "Travel"),
    (r"southwest|delta air|american airlines|united air", "Travel"),
    (r"marriott|hilton|hyatt|holiday inn|airbnb", "Travel"),

    # ---- Rent / Property ----
    (r"\brent\b|lease pmt",         "Rent Expense"),
]

# ------------------------------------------------------------
# DATA CLASSES
# ------------------------------------------------------------

@dataclass
class Transaction:
    statement_file: str
    bank_account: str           # e.g. "BMO Checking - 6001"
    date: str                   # ISO format YYYY-MM-DD
    description: str
    amount: float               # positive = money out (debit expense), negative = money in
    txn_type: str               # 'debit' | 'credit' | 'check' | 'fee' | 'deposit' | 'transfer'
    raw_line: str = ""
    # Categorization output
    account_assigned: Optional[str] = None
    confidence: str = ""        # 'rule' | 'gl_match' | 'ai' | 'duplicate' | 'unmapped'
    notes: str = ""
    is_duplicate: bool = False
    fingerprint: str = ""

    def compute_fingerprint(self, strictness: str = "date_amount_desc") -> str:
        """Create a hash for duplicate detection."""
        if strictness == "date_amount":
            key = f"{self.date}|{self.amount:.2f}"
        elif strictness == "strict":
            key = f"{self.date}|{self.amount:.2f}|{self.description.lower().strip()}"
        else:  # date_amount_desc - normalized
            normalized_desc = re.sub(r"\s+", " ", self.description.lower().strip())
            normalized_desc = re.sub(r"[^\w\s]", "", normalized_desc)[:40]
            key = f"{self.date}|{self.amount:.2f}|{normalized_desc}"
        self.fingerprint = hashlib.md5(key.encode()).hexdigest()
        return self.fingerprint


# ------------------------------------------------------------
# PDF PARSING
# ------------------------------------------------------------

# Common bank statement transaction line patterns
# Row formats vary widely between banks - we try multiple patterns

DATE_PATTERNS = [
    r"(\d{1,2}/\d{1,2}/\d{2,4})",       # 03/15/2025
    r"(\d{1,2}-\d{1,2}-\d{2,4})",       # 03-15-2025
    r"([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})",  # Mar 15, 2025
]

AMOUNT_PATTERN = r"(-?\$?\d{1,3}(?:,\d{3})*(?:\.\d{2}))"


def parse_amount(amt_str: str) -> float:
    """Convert '1,234.56' or '$1,234.56' or '(1,234.56)' to float."""
    if not amt_str:
        return 0.0
    s = amt_str.strip().replace("$", "").replace(",", "")
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except ValueError:
        return 0.0


def normalize_date(date_str: str) -> str:
    """Convert various date formats to ISO YYYY-MM-DD."""
    date_str = date_str.strip()
    formats = [
        "%m/%d/%Y", "%m/%d/%y",
        "%m-%d-%Y", "%m-%d-%y",
        "%b %d, %Y", "%b %d %Y",
        "%B %d, %Y",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return date_str  # return as-is if we can't parse


def detect_bank_account(pdf_path: str, first_page_text: str, config: dict) -> str:
    """Determine which bank account this statement belongs to."""
    fname = os.path.basename(pdf_path).lower()
    text = first_page_text.lower()

    # Check filename hints first
    if "bmo" in fname:
        for last4, info in config["bank_accounts"].items():
            if "bmo" in info["name"].lower():
                return info["name"]
    if "payroll" in fname:
        for last4, info in config["bank_accounts"].items():
            if "payroll" in info["name"].lower():
                return info["name"]
    if "loc" in fname or "line of credit" in fname:
        for last4, info in config["bank_accounts"].items():
            if "loc" in info["name"].lower() or "line of credit" in info["name"].lower():
                return info["name"]
    if "tasi" in fname or "operating" in fname or " op" in fname:
        for last4, info in config["bank_accounts"].items():
            if "tasi" in info["name"].lower() and "payroll" not in info["name"].lower() and "loc" not in info["name"].lower():
                return info["name"]

    # Check for last-4 in text
    for last4, info in config["bank_accounts"].items():
        if last4 in text or last4 in fname:
            return info["name"]

    return f"UNKNOWN ({os.path.basename(pdf_path)})"


def extract_transactions_from_pdf(pdf_path: str, config: dict) -> list[Transaction]:
    """Extract transactions from a single PDF statement.

    This is the trickiest part - bank statement layouts vary. We use a
    line-based approach: scan each line for a date + amount pattern, and
    treat the text between as the description.
    """
    transactions = []
    bank_account = None

    with pdfplumber.open(pdf_path) as pdf:
        # Detect bank account from first page
        if pdf.pages:
            first_text = pdf.pages[0].extract_text() or ""
            bank_account = detect_bank_account(pdf_path, first_text, config)
        else:
            bank_account = f"UNKNOWN ({os.path.basename(pdf_path)})"

        all_text_lines = []
        for page_num, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            for line in text.split("\n"):
                line = line.strip()
                if line:
                    all_text_lines.append((page_num, line))

    # Determine statement year context (look for it in header)
    stmt_year = None
    for _, line in all_text_lines[:30]:
        m = re.search(r"\b(20\d{2})\b", line)
        if m:
            stmt_year = m.group(1)
            break
    if not stmt_year:
        stmt_year = str(datetime.now().year)

    for page_num, line in all_text_lines:
        # Skip obvious header / footer lines
        if any(skip in line.lower() for skip in [
            "page ", "statement period", "account number", "customer service",
            "balance forward", "ending balance", "beginning balance",
            "total debits", "total credits", "fdic"
        ]):
            continue

        # Look for date at start of line
        date_match = None
        for pat in DATE_PATTERNS:
            m = re.match(pat, line)
            if m:
                date_match = m
                break

        if not date_match:
            continue

        # Look for amount(s) at end of line
        amounts = re.findall(AMOUNT_PATTERN, line)
        if not amounts:
            continue

        # Heuristic: last amount is the transaction amount, second-to-last is balance
        # If only one amount, it's the transaction
        txn_amount_str = amounts[-1] if len(amounts) == 1 else amounts[-2]
        txn_amount = parse_amount(txn_amount_str)

        if txn_amount == 0:
            continue

        # Description is everything between date and first amount
        date_end = date_match.end()
        first_amt_idx = line.find(amounts[0], date_end)
        if first_amt_idx < 0:
            continue
        description = line[date_end:first_amt_idx].strip()
        description = re.sub(r"\s+", " ", description)

        # Add year if missing from date
        date_str = date_match.group(1)
        if len(date_str.split("/")[-1]) == 2 or len(date_str.split("-")[-1]) == 2 or "20" not in date_str:
            # short year or no year
            if "/" in date_str and len(date_str.split("/")) == 2:
                date_str = f"{date_str}/{stmt_year}"
            elif "-" in date_str and len(date_str.split("-")) == 2:
                date_str = f"{date_str}-{stmt_year}"

        iso_date = normalize_date(date_str)

        # Determine txn type from keywords
        desc_lower = description.lower()
        if any(k in desc_lower for k in ["deposit", "credit", "transfer in"]):
            txn_type = "deposit"
            # Deposits typically increase the bank balance => negative "expense" amount
            amount_signed = -abs(txn_amount)
        elif "check" in desc_lower or re.match(r"^\s*ck\b", desc_lower):
            txn_type = "check"
            amount_signed = abs(txn_amount)
        elif "fee" in desc_lower or "service charge" in desc_lower:
            txn_type = "fee"
            amount_signed = abs(txn_amount)
        elif "transfer" in desc_lower:
            txn_type = "transfer"
            amount_signed = abs(txn_amount)
        else:
            txn_type = "debit"
            amount_signed = abs(txn_amount)

        txn = Transaction(
            statement_file=os.path.basename(pdf_path),
            bank_account=bank_account or "UNKNOWN",
            date=iso_date,
            description=description,
            amount=amount_signed,
            txn_type=txn_type,
            raw_line=line,
        )
        transactions.append(txn)

    return transactions


# ------------------------------------------------------------
# GL INGESTION
# ------------------------------------------------------------

def load_gl(gl_csv_path: str, strictness: str = "date_amount_desc") -> tuple[dict, set]:
    """Load GL export and return (vendor_map, fingerprint_set).

    vendor_map: {vendor_keyword_lower: account_name}
    fingerprint_set: {fingerprints of existing transactions}

    QBO GL CSV columns vary - we try common header names:
        Date, Transaction Type, Num, Name, Memo/Description, Account, Debit, Credit, Amount
    """
    vendor_map = {}
    fingerprints = set()

    if not os.path.exists(gl_csv_path):
        logging.warning(f"GL file not found: {gl_csv_path}")
        return vendor_map, fingerprints

    # Detect encoding / delimiter
    with open(gl_csv_path, "r", encoding="utf-8-sig", errors="replace") as f:
        sample = f.read(8192)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(f, dialect=dialect)
        headers = {h.lower().strip(): h for h in (reader.fieldnames or [])}

        def get(row, *keys):
            for k in keys:
                if k.lower() in headers:
                    return row.get(headers[k.lower()], "") or ""
            return ""

        for row in reader:
            date_raw = get(row, "Date", "Transaction Date", "Txn Date")
            name = get(row, "Name", "Vendor", "Payee", "Customer")
            memo = get(row, "Memo/Description", "Memo", "Description")
            account = get(row, "Account", "Split", "Category")
            amount = get(row, "Amount", "Debit", "Credit")

            if not date_raw:
                continue

            iso_date = normalize_date(date_raw.strip())

            # Build vendor map from Name + Account where account is an expense/income (skip bank/AR/AP)
            if name and account:
                acct_lower = account.lower()
                # Skip clearing-style accounts
                if not any(skip in acct_lower for skip in [
                    "accounts receivable", "accounts payable", "checking",
                    "savings", "credit card", "tasi", "bmo"
                ]):
                    vendor_key = name.strip().lower()
                    if vendor_key and vendor_key not in vendor_map:
                        vendor_map[vendor_key] = account.strip()

            # Build fingerprint set for duplicate detection
            try:
                amt = parse_amount(amount)
            except Exception:
                amt = 0.0
            if amt == 0:
                continue

            desc_for_fp = (name + " " + memo).strip()
            normalized = re.sub(r"\s+", " ", desc_for_fp.lower().strip())
            normalized = re.sub(r"[^\w\s]", "", normalized)[:40]

            if strictness == "date_amount":
                key = f"{iso_date}|{abs(amt):.2f}"
            elif strictness == "strict":
                key = f"{iso_date}|{abs(amt):.2f}|{desc_for_fp.lower().strip()}"
            else:
                key = f"{iso_date}|{abs(amt):.2f}|{normalized}"
            fingerprints.add(hashlib.md5(key.encode()).hexdigest())

    logging.info(f"GL loaded: {len(vendor_map)} vendor mappings, {len(fingerprints)} fingerprints")
    return vendor_map, fingerprints


# ------------------------------------------------------------
# CATEGORIZATION ENGINE
# ------------------------------------------------------------

def apply_rule_engine(txn: Transaction) -> Optional[str]:
    """Apply hardcoded vendor rules. Returns account name or None."""
    desc_lower = txn.description.lower()
    for pattern, account in VENDOR_RULES:
        if re.search(pattern, desc_lower):
            return account
    return None


def apply_gl_lookup(txn: Transaction, vendor_map: dict) -> Optional[str]:
    """Look up the transaction's description against the GL vendor map."""
    desc_lower = txn.description.lower()

    # Exact substring match against vendor names from GL
    for vendor_key, account in vendor_map.items():
        if len(vendor_key) >= 4 and vendor_key in desc_lower:
            return account

    return None


def categorize_transaction(
    txn: Transaction,
    vendor_map: dict,
    fingerprints: set,
    config: dict,
) -> Transaction:
    """Run a single transaction through the categorization pipeline."""
    txn.compute_fingerprint(config.get("duplicate_strictness", "date_amount_desc"))

    # 1. Duplicate check
    if txn.fingerprint in fingerprints:
        txn.is_duplicate = True
        txn.confidence = "duplicate"
        txn.notes = "Matches existing GL transaction - SKIP"
        return txn

    # 2. Rule engine
    rule_account = apply_rule_engine(txn)
    if rule_account:
        txn.account_assigned = rule_account
        txn.confidence = "rule"
        return txn

    # 3. GL vendor map
    gl_account = apply_gl_lookup(txn, vendor_map)
    if gl_account:
        txn.account_assigned = gl_account
        txn.confidence = "gl_match"
        return txn

    # 4. Mark as unmapped (will be sent to AI in batch)
    txn.confidence = "unmapped"
    return txn


# ------------------------------------------------------------
# AI CATEGORIZATION (BATCH)
# ------------------------------------------------------------

def ai_categorize_batch(unmapped: list[Transaction], coa_accounts: list[str], config: dict) -> None:
    """Call Claude to categorize unmapped transactions in batch.

    Mutates the transactions in-place (sets account_assigned + confidence='ai').
    Requires ANTHROPIC_API_KEY env var. If unavailable, falls back to
    'Ask My Accountant' for everything.
    """
    if not unmapped:
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    fallback = config.get("default_unmapped_account", "Ask My Accountant")

    if not config.get("ai_enabled") or not api_key:
        logging.warning(
            f"AI disabled or ANTHROPIC_API_KEY not set - using '{fallback}' for {len(unmapped)} unmapped"
        )
        for t in unmapped:
            t.account_assigned = fallback
            t.confidence = "unmapped"
            t.notes = "No rule, no GL match, AI disabled"
        return

    try:
        import anthropic
    except ImportError:
        logging.error("anthropic package not installed - run: pip install anthropic")
        for t in unmapped:
            t.account_assigned = fallback
            t.confidence = "unmapped"
            t.notes = "anthropic package missing"
        return

    client = anthropic.Anthropic(api_key=api_key)

    # Build the prompt
    txn_list = "\n".join([
        f"{i+1}. {t.date} | {t.description[:80]} | ${t.amount:.2f}"
        for i, t in enumerate(unmapped)
    ])
    coa_text = "\n".join([f"- {a}" for a in coa_accounts])

    system = (
        "You are an expert bookkeeper for a gas/lube wholesale business (Americas Energy). "
        "You categorize bank transactions to the correct account from a Chart of Accounts. "
        "Return ONLY a valid JSON array with one object per transaction in the same order. "
        "Each object: {\"index\": N, \"account\": \"Account Name\", \"reason\": \"brief\"}. "
        "Use exact account names from the COA. If unclear, use \"Ask My Accountant\"."
    )

    user = f"""Chart of Accounts:
{coa_text}

Categorize these {len(unmapped)} transactions:
{txn_list}

Return JSON array, no preamble, no markdown."""

    try:
        resp = client.messages.create(
            model=config.get("ai_model", "claude-sonnet-4-20250514"),
            max_tokens=4000,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = resp.content[0].text.strip()
        # Strip code fences if present
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE)
        results = json.loads(text)

        for r in results:
            idx = r.get("index", 0) - 1
            if 0 <= idx < len(unmapped):
                unmapped[idx].account_assigned = r.get("account", fallback)
                unmapped[idx].confidence = "ai"
                unmapped[idx].notes = r.get("reason", "")
    except Exception as e:
        logging.error(f"AI categorization failed: {e}")
        for t in unmapped:
            if not t.account_assigned:
                t.account_assigned = fallback
                t.confidence = "unmapped"
                t.notes = f"AI error: {str(e)[:60]}"


# ------------------------------------------------------------
# OUTPUT - QBO JE IMPORT CSV
# ------------------------------------------------------------

def write_je_csv(transactions: list[Transaction], output_path: str) -> int:
    """Write transactions as QBO journal entry import CSV.

    One JE per transaction. Format matches QBO's standard JE import:
        JournalNo, JournalDate, Currency, Memo, AccountName, Debits, Credits, Description, Name, Class, Location

    Returns count of JEs written (excludes duplicates).
    """
    written = 0
    je_num = 1

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "JournalNo", "JournalDate", "Currency", "Memo",
            "AccountName", "Debits", "Credits", "Description"
        ])

        for txn in transactions:
            if txn.is_duplicate:
                continue
            if not txn.account_assigned:
                continue

            je_id = f"BR-{je_num:04d}"
            memo = f"{txn.description[:80]} ({txn.statement_file})"

            # Determine debit/credit direction
            # amount > 0 = money leaving bank (expense or asset reduction)
            #   -> Debit expense account, Credit bank account
            # amount < 0 = money entering bank (deposit/credit)
            #   -> Debit bank account, Credit income/source account
            amt = abs(txn.amount)
            if txn.amount >= 0:
                # Expense side
                writer.writerow([
                    je_id, txn.date, "USD", memo,
                    txn.account_assigned, f"{amt:.2f}", "",
                    txn.description[:100]
                ])
                # Bank side (credit)
                writer.writerow([
                    je_id, txn.date, "USD", memo,
                    txn.bank_account, "", f"{amt:.2f}",
                    txn.description[:100]
                ])
            else:
                # Deposit
                writer.writerow([
                    je_id, txn.date, "USD", memo,
                    txn.bank_account, f"{amt:.2f}", "",
                    txn.description[:100]
                ])
                writer.writerow([
                    je_id, txn.date, "USD", memo,
                    txn.account_assigned, "", f"{amt:.2f}",
                    txn.description[:100]
                ])

            written += 1
            je_num += 1

    return written


def write_review_report(transactions: list[Transaction], output_path: str) -> dict:
    """Write a human-readable review report and return summary stats."""
    by_confidence = defaultdict(list)
    for t in transactions:
        by_confidence[t.confidence].append(t)

    by_account = defaultdict(lambda: {"count": 0, "total": 0.0})
    for t in transactions:
        if t.is_duplicate or not t.account_assigned:
            continue
        by_account[t.account_assigned]["count"] += 1
        by_account[t.account_assigned]["total"] += abs(t.amount)

    summary = {
        "total_transactions": len(transactions),
        "by_confidence": {k: len(v) for k, v in by_confidence.items()},
        "duplicates": len([t for t in transactions if t.is_duplicate]),
        "ready_to_import": len([t for t in transactions if not t.is_duplicate and t.account_assigned]),
        "needs_review": len([t for t in transactions if t.confidence in ("unmapped", "ai")]),
        "by_account": dict(by_account),
    }

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("=" * 80 + "\n")
        f.write("ARK BANK RECONCILIATION - REVIEW REPORT\n")
        f.write(f"Generated: {datetime.now().isoformat()}\n")
        f.write("=" * 80 + "\n\n")

        f.write("SUMMARY\n")
        f.write("-" * 80 + "\n")
        f.write(f"  Total transactions parsed: {summary['total_transactions']}\n")
        f.write(f"  Duplicates (skipped):      {summary['duplicates']}\n")
        f.write(f"  Ready to import:           {summary['ready_to_import']}\n")
        f.write(f"  Need review:               {summary['needs_review']}\n\n")

        f.write("  By confidence:\n")
        for k, v in summary["by_confidence"].items():
            f.write(f"    {k:15s}  {v}\n")
        f.write("\n")

        f.write("BY ACCOUNT\n")
        f.write("-" * 80 + "\n")
        for acct, info in sorted(by_account.items(), key=lambda x: -x[1]["total"]):
            f.write(f"  {acct:40s}  {info['count']:4d} txns  ${info['total']:>12,.2f}\n")
        f.write("\n")

        # Duplicates section
        if by_confidence["duplicate"]:
            f.write("DUPLICATES (NOT IMPORTED - already in GL)\n")
            f.write("-" * 80 + "\n")
            for t in by_confidence["duplicate"]:
                f.write(f"  {t.date} | {t.bank_account[:25]:25s} | ${t.amount:>10.2f} | {t.description[:50]}\n")
            f.write("\n")

        # AI / unmapped
        if by_confidence["ai"] or by_confidence["unmapped"]:
            f.write("AI-CATEGORIZED / UNMAPPED (REVIEW THESE)\n")
            f.write("-" * 80 + "\n")
            for t in by_confidence["ai"] + by_confidence["unmapped"]:
                f.write(f"  {t.date} | ${t.amount:>10.2f} | {t.description[:40]:40s} -> {t.account_assigned or 'NONE'}\n")
                if t.notes:
                    f.write(f"      note: {t.notes}\n")
            f.write("\n")

    # Also write full detail as CSV for spreadsheet review
    csv_path = output_path.replace(".txt", "_detail.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Statement", "Bank Account", "Date", "Description", "Amount",
            "Type", "Account Assigned", "Confidence", "Is Duplicate", "Notes"
        ])
        for t in transactions:
            writer.writerow([
                t.statement_file, t.bank_account, t.date, t.description,
                f"{t.amount:.2f}", t.txn_type, t.account_assigned or "",
                t.confidence, "YES" if t.is_duplicate else "", t.notes
            ])

    return summary


# ------------------------------------------------------------
# COA HELPERS
# ------------------------------------------------------------

def load_coa_accounts(coa_csv_path: Optional[str]) -> list[str]:
    """Load COA account names. Returns a default list if file missing."""
    if coa_csv_path and os.path.exists(coa_csv_path):
        accounts = []
        with open(coa_csv_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                name = row.get("Account Name") or row.get("Name") or row.get("AccountName")
                if name:
                    accounts.append(name.strip())
        return accounts

    # Default Americas Energy COA (subset relevant for bank rec)
    return [
        # Bank/Cash
        "BMO Checking - 6001", "TASI - 1249", "TASI Payroll", "TASI Line of Credit",
        # AR/AP
        "Accounts Receivable", "Accounts Payable",
        # Liabilities
        "Chase Credit Card", "AMEX Credit Card", "Fuel Taxes Payable",
        "Sales Tax Payable - State",
        # Income
        "Sales - Gasoline", "Sales - Diesel", "Sales - Lubricants",
        "Sales - DEF", "Freight & Delivery Income",
        # COGS
        "COGS - Gasoline", "COGS - Diesel", "COGS - Lubricants", "Freight Expense",
        # Expenses
        "Fleet Management Fees", "Telephone & Internet", "Software & Subscriptions",
        "Bank Service Charges", "Interest Expense", "Insurance Expense",
        "Utilities", "Gas Utilities", "Rent Expense", "Vehicle Maintenance",
        "Fuel Use", "Office Supplies", "Professional Fees", "Travel",
        "Meals & Entertainment", "Tax Expense", "Payroll - Wages",
        "Payroll Taxes", "Payroll Processing Fees", "Repairs & Maintenance",
        # Suspense
        "Ask My Accountant", "Uncategorized Expense",
    ]


# ------------------------------------------------------------
# MAIN
# ------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ARK Bank Reconciliation Tool")
    parser.add_argument("--statements", required=True, help="Folder containing PDF statements")
    parser.add_argument("--gl", required=True, help="GL export CSV path")
    parser.add_argument("--output", default="./output", help="Output folder")
    parser.add_argument("--config", default="./config.json", help="Client config JSON")
    parser.add_argument("--coa", default=None, help="Optional COA CSV (account names list)")
    parser.add_argument("--no-ai", action="store_true", help="Disable AI categorization")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    # Load config
    config = dict(DEFAULT_CONFIG)
    if os.path.exists(args.config):
        with open(args.config) as f:
            config.update(json.load(f))
    if args.no_ai:
        config["ai_enabled"] = False

    os.makedirs(args.output, exist_ok=True)

    # ---- 1. Parse all PDFs ----
    statements_dir = Path(args.statements)
    pdf_files = sorted(statements_dir.glob("*.pdf")) + sorted(statements_dir.glob("*.PDF"))
    pdf_files = list(set(pdf_files))

    if not pdf_files:
        logging.error(f"No PDFs found in {statements_dir}")
        sys.exit(1)

    logging.info(f"Found {len(pdf_files)} PDF statement(s)")

    all_txns = []
    for pdf in pdf_files:
        logging.info(f"Parsing {pdf.name}...")
        try:
            txns = extract_transactions_from_pdf(str(pdf), config)
            logging.info(f"  -> {len(txns)} transactions extracted")
            all_txns.extend(txns)
        except Exception as e:
            logging.error(f"  -> FAILED: {e}")

    if not all_txns:
        logging.error("No transactions extracted from any PDF")
        sys.exit(1)

    logging.info(f"Total transactions parsed: {len(all_txns)}")

    # ---- 2. Load GL ----
    logging.info(f"Loading GL: {args.gl}")
    vendor_map, fingerprints = load_gl(args.gl, config.get("duplicate_strictness", "date_amount_desc"))

    # ---- 3. Categorize ----
    logging.info("Running categorization engine...")
    coa_accounts = load_coa_accounts(args.coa)

    for t in all_txns:
        categorize_transaction(t, vendor_map, fingerprints, config)

    unmapped = [t for t in all_txns if t.confidence == "unmapped" and not t.is_duplicate]
    logging.info(
        f"  rules: {sum(1 for t in all_txns if t.confidence == 'rule')} | "
        f"gl_match: {sum(1 for t in all_txns if t.confidence == 'gl_match')} | "
        f"duplicates: {sum(1 for t in all_txns if t.is_duplicate)} | "
        f"unmapped: {len(unmapped)}"
    )

    # ---- 4. AI batch for unmapped ----
    if unmapped:
        logging.info(f"Calling AI for {len(unmapped)} unmapped transactions...")
        # Process in chunks of 50 to keep prompts reasonable
        for i in range(0, len(unmapped), 50):
            chunk = unmapped[i:i + 50]
            ai_categorize_batch(chunk, coa_accounts, config)

    # ---- 5. Output ----
    je_path = os.path.join(args.output, "qbo_je_import.csv")
    review_path = os.path.join(args.output, "review_report.txt")

    je_count = write_je_csv(all_txns, je_path)
    summary = write_review_report(all_txns, review_path)

    logging.info("=" * 60)
    logging.info(f"DONE. Wrote {je_count} JEs to {je_path}")
    logging.info(f"Review report: {review_path}")
    logging.info(f"Summary: {summary['ready_to_import']} ready, {summary['duplicates']} dupes, {summary['needs_review']} need review")


if __name__ == "__main__":
    main()
