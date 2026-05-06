# New Hire Reporting — State Compliance Spec

Living reference for the catch-all New Hire reporting flow in ark-dashboard.html. Keep this updated when statutes change or when we add per-state filing automation.

**Last research pass:** 2026-05-06 (OCSE matrix dated 2025-03-22 → 2026-04-08)
**Raw OCSE source:** `Projects/ocse_state_matrix.txt` (untracked) — full state-by-state contact and program data
**Build phase:** A (catch-all data capture) shipping next; B (per-state filing for top 5 clients' states) follows; C (full portal automation) is the long-term goal.

---

## Federal baseline (PRWORA, 42 USC §653a)

Every state requires at minimum:

- Employee first / middle / last name
- Employee mailing address (street1, street2, city, state, ZIP) — **NH forbids P.O. Box**
- Employee SSN — **FL also accepts ITIN**
- Date of hire / first day of work
- Employer legal name
- Employer mailing address
- Employer FEIN

States can add fields, shorten the deadline, require independent contractors, and demand specific submission formats.

---

## Catch-all field set (the form's actual inputs)

Sorted by frequency across all 53 jurisdictions. Required-on-our-form means we capture for every employee even if the destination state doesn't need it — over-collection is cheap, under-collection is failed compliance.

### Always capture (above and beyond federal baseline)

| Field | Why we capture | States that require |
|---|---|---|
| **Work state / state of hire** | Multistate-employer rule and ~25 states explicitly require | AK, AZ, CT, DE, FL, IA, ID, IL, IN, KS, LA, MS, NE, NM, NC, OH, OR, RI, TN, VA, WY (multistate); optional in HI, MO, NV, RI |
| **Date of birth** | Required in 10–12 states, optional in 12 more | AK, GA, IA, MA, MS, NJ, NM, OH, PR, VI, WA, WV |
| **Job title (free text)** + **6-digit SOC code** | Indiana mandatory since 2025-07-01 (SB 148); LA, OK also require; we require for all clients to future-proof | IN, LA, OK |
| **Salary / starting wage**, **rate of pay**, **pay frequency** | IN required, OK required; the rest treat as optional | IN, OK; HI/MS optional |
| **Employee type** (W-2 employee vs. independent contractor) | Several states accept ICs through the same flow with this flag | CT, MA, NJ, NY, OH, etc. |
| **Health insurance available?** + **eligibility/qualification date** | Required in NY (Tax Law §171-h), IA, GA, ND, OH, PR, VI | NY, IA, GA, ND, OH, PR, VI |
| **State Employer ID Number** (per-state UI/SEIN) | Several states key the report to their UI account number | AK, CA (EDD), HI, ID, LA, MO, NC, NH, VI |
| **Address for income-withholding orders** | Required separately when different from corporate address | KS, VA |

### IC-specific (capture when type = contractor)

| Field | Why we capture |
|---|---|
| **Contract amount ($)** | Triggers state IC reporting thresholds (CA $600 · CT $5K · MA $600 · NH $2.5K · NY $2.5K · OH $2.5K · WV $2.5K · IA >$600) |
| **Contract start date** | Used as "first day of work" surrogate for ICs |
| **Contract length / duration of services** | Ohio explicitly requires (ORC §3121.892) |
| **Date payment begins** | Ohio explicit; semantically distinct from contract start |

### Edge cases (one field per quirk)

| Field | Why we capture |
|---|---|
| **Mother's maiden name** | Puerto Rico requires (yes, really) |
| **Prior separation date** | Vermont uses "≥60 days separated" as the rehire-vs-new-hire test |
| **SSN-received date** | NY clock for non-resident-visa hires starts when SSN is received, not hire date |

### Things we explicitly do NOT capture (verified against primary sources)

- Driver's license # / state — used in W-4 / I-9, never in NHR
- Citizenship status, race, ethnicity — not required by any state's NHR
- Employee gender — listed optional in DE/MS only; skip
- Employee home phone — not required anywhere

---

## Reporting deadlines

Used to drive the form's "due in N days" badge and the state filing queue.

| Days from hire | States |
|---|---|
| **7** (statute) | AL, ME |
| **10** | GA, VT |
| **14** | CT (online), MA, RI, WV |
| **15** | IA, MS |
| **20** (federal default) | All others |

**Conflict resolution decisions (locked-in):**
- **Connecticut:** treat as 14 days (online portal language) even though OCSE matrix says 20. Overshooting is safe.
- **Alabama:** 7 days per Ala. Code §25-11-5. Statute wins over secondary sources that say 20.
- **Maine:** 7 calendar days (not business days) until proven otherwise.

**Multistate-employer election (federal):** if elected, all hires file through one chosen state. Must be electronic, submitted **twice monthly, 12–16 days apart**. Form OMB-0970-0166.

---

## Independent contractor reporting

States that require IC reporting and the threshold:

| State | Threshold | Notes |
|---|---|---|
| California | $600 / yr | Separate Form DE 542 (not DE 34) |
| Colorado | — | Service recipients report ICs same as employees |
| Connecticut | $5,000 / yr | Separate "service provider" flow on ctnewhires.com |
| Florida | — | Required, unspecified threshold |
| Iowa | > $600 | Through ePay |
| Illinois | — | Required |
| Maine | — | Required, single form, indicator |
| Massachusetts | $600 / yr | Mandatory electronic if ≥25 employees+ICs |
| Minnesota | — | Required for state agencies/political subdivisions only; optional otherwise |
| Nebraska | — | Required |
| New Hampshire | > $2,500 | Or break ≥60 days then > $2,500 |
| New Jersey | — | Required, type-of-hire indicator |
| New York | $2,500 contract | Separate online flow at tax.ny.gov |
| Ohio | $2,500 anticipated | Separate IC-specific data fields per ORC §3121.892 |
| Oregon | engaged > 20 days | Filed within 20 days of engagement/reengagement |
| Texas | — | Required |
| Virginia | — | Per 23VAC10-500-130 |
| Vermont | — | Required for "any individual who is paid for services" |
| West Virginia | $2,500 | Required |

**Tennessee:** OCSE matrix says no IC reporting required, but penalty schedule references contractors. Default to no IC reporting in TN; revisit if a TN client adds heavy contractor volume.

---

## Submission methods

Every jurisdiction has a web portal. Many also accept SFTP, fax, mail. Two electronic-mandatory states:

- **Massachusetts** — electronic mandatory if employer has ≥25 employees + ICs
- **Vermont** — electronic mandatory if ≥10 submissions per reporting period

**National file format:** OCSE publishes a fixed-width spec (`ndnh_guide_for_data_submission.pdf`); many state portals accept that layout for bulk SFTP. State-specific file specs vary — research before building bulk-upload support per state.

---

## Format constraints

- **SSN**: 9 digits, XXX-XX-XXXX. FL substitutes ITIN if SSN unavailable.
- **FEIN**: 9 digits, XX-XXXXXXX.
- **SOC code**: 6 digits with or without dash (`12-3456` or `123456`). Required field on our form.
- **Dates**: store ISO `YYYY-MM-DD`, serialize per destination. Most portals accept `MM/DD/YYYY`; Iowa ePay and some FTP specs use `YYYYMMDD`.
- **Address**: store street1 / street2 / city / state / ZIP separately. NH validation: must not be a P.O. Box.

---

## Build phases

### Phase A — Catch-all data capture (in scope now)
Extend the New Hire modal in ark-dashboard.html to capture every field above. Server stores on `employee` record (extends existing schema).

### Phase B — Per-state filing for top 5 priority states (next)
"Generate state filing" button produces a state-correct PDF/CSV from captured data. Priority states TBD by client volume — **awaiting answer from Jacob**.

### Phase C — Full portal automation (long-term)
Direct API / portal submission per state where supported. Scope is multi-week per state due to wide variance in portals (online forms, SFTP, magnetic media, fax). Would need:
- OCSE multistate-employer election filed for ARK
- Per-state portal credentials stored encrypted
- A queue/retry layer for failed submissions
- Audit log of every submission with state response codes

---

## Open items to revisit

These weren't fully resolved in primary sources during the 2026-05-06 research pass:

1. **TN IC reporting** — OCSE matrix says no, penalty language hints yes. Phone TN New Hire (888-715-2280) before adding TN clients with contractor volume.
2. **IN SOC code enforcement** — Whether the in-newhire.com online single-record form rejects without SOC, or only the bulk SFTP file. Affects whether SOC must be required on day 1 of hire vs. backfilled.
3. **VT electronic-mandatory threshold** — ">10 submissions per reporting period" — confirm whether per-month or per-quarter.
4. **NY non-resident-visa SSN-received date** — confirm whether NY DTF wants the SSN-received date on the report itself or only as an internal compliance trigger.
5. **MA "payor of income" definition** — broader than "employer"; covers trustees, pension administrators, royalty payers. Confirm scope when a client falls into one of those categories.
6. **CT IC portal** — confirm ctnewhires.com handles both the employee NHR and the IC service-provider filing, or whether IC has a separate URL.
7. **Ohio IC fields** — pull ORC §3121.892 text directly to confirm the field list is complete.
8. **PR mother's maiden name** — captured on our form. Confirm whether the PR portal validates as hard requirement vs. optional when filing.
9. **CA DE 34 vs. DE 542 split** — make sure Phase B produces two distinct outputs, not one combined form.
10. **State-specific bulk file formats** — enumerate which states accept the OCSE national fixed-width vs. publish their own spec. Needed before Phase C.

---

## References

- [OCSE state contact matrix (PDF)](https://ocsp.acf.hhs.gov/irg/irgpdf.pdf?geoType=OGP&groupCode=EMP&addrType=NHR&addrClassType=EMP) — primary source
- [ACF/OCSE state new hire reporting contacts](https://acf.gov/css/contact-information/state-new-hire-reporting-contacts-and-program-requirements)
- [Multistate Employer Registration Form (OMB-0970-0166)](https://acf.gov/sites/default/files/documents/ocse/mse_form.pdf)
- [NDNH Guide for Data Submission v13.4](https://acf.gov/sites/default/files/documents/ocse/ndnh_guide_for_data_submission.pdf)
- [NY Tax Law §171-h](https://www.nysenate.gov/legislation/laws/TAX/171-H)
- [MA 830 CMR 62E.2.1](https://www.mass.gov/regulations/830-CMR-62e21-reporting-of-new-hires)
- [Iowa Code Ch. 252G (Central Employee Registry)](https://www.legis.iowa.gov/docs/ico/chapter/252G.pdf)
- [Indiana DWD SB 148 implementation](https://www.in.gov/dwd/indiana-unemployment/employers/employer-guide/unemployer-insurance-employer-guide/new-hire-reporting/)
- [Va. Code §63.2-1946](https://law.lis.virginia.gov/vacode/title63.2/chapter19/section63.2-1946/)
- [23VAC10-500-130 (VA IC reporting)](https://law.lis.virginia.gov/admincode/title23/agency10/chapter500/section130/)
