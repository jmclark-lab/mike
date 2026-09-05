# Golden eval report

- Mode: `dry-run`
- Generated: 2026-09-05T13:25:59.407Z
- Fixtures: 30 (15 contract, 15 regulatory)
- Pass rate: n/a (dry-run — fixtures validated, no model calls)

## Notes

- Dry-run only: fixtures parsed and validated. No model was called.
- Load 30 fixtures (15 contract, 15 regulatory).
- Validate YAML frontmatter (id, category, question) and synthetic context body.
- Dry-run stops here: no LLM calls, write sample markdown report.
- Live mode (ANTHROPIC_API_KEY or LLM_MODEL): one completeText call per fixture using the active main model.
- Optional --council: conveneCouncil per fixture (expensive; opt-in only).
- Score with must_mention / must_not_claim substring checks; pass rate = passed / total.
- Fixture files live in evals/golden/fixtures/.

## Scoring

v1 scores are **keyword / rubric checks**, not LLM-as-judge. A fixture **passes** when the answer is non-empty, every `must_mention` term appears (case-insensitive substring), and no `must_not_claim` term appears. Use the pass rate to compare model upgrades on the same fixture set.

## Fixtures

| ID | Category | Result | Rubric / keywords |
| --- | --- | --- | --- |
| `contract-cta-assignment-14` | contract | planned | Mutual affiliate assignment; CRO may subcontract with notice while remaining responsible. — mention: assign, affiliate, subcontract; forbid: CRO may freely assign to a competitor, this is legal advice |
| `contract-cta-audit-13` | contract | planned | Allow reasonable scheduled audits plus for-cause access; protect unrelated clients and allocate routine audit cost. — mention: notice, for-cause, confidential; forbid: refuse all sponsor audits, this is legal advice |
| `contract-cta-confidentiality-10` | contract | planned | Permit required ethics, agency, and legal disclosures; keep a narrow residual confidentiality duty. — mention: ethics, regulatory, required by law; forbid: do not notify the ethics committee, this is legal advice |
| `contract-cta-import-delay-12` | contract | planned | Agency/customs holds are not CRO breach; use force majeure or an equitable schedule relief. — mention: force majeure, import, agency; forbid: CRO controls customs release, this is legal advice |
| `contract-cta-indemnity-01` | contract | planned | Flag uncapped CRO indemnity as a deal risk and propose a cap tied to fees. — mention: indemnif, cap, uncapped; forbid: this is legal advice, file this study with the FDA |
| `contract-cta-insurance-07` | contract | planned | Subject-injury / trial insurance is typically a Sponsor obligation; CRO carries professional liability at a reasonable limit. — mention: sponsor, insurance, subject injury; forbid: CRO is always the policyholder for subject injury, this is legal advice |
| `contract-cta-ip-data-02` | contract | planned | Sponsor owns study data/inventions; CRO keeps a limited performance and methods license. — mention: sponsor, license, de-identified; forbid: CRO owns the trial data, this is legal advice |
| `contract-cta-payment-03` | contract | planned | Flag enrollment-only pay as cash-flow risk; recommend startup plus enrollment/monitoring milestones. — mention: milestone, startup, enrollment; forbid: payment is guaranteed, this is legal advice |
| `contract-cta-publication-08` | contract | planned | Allow time-limited Sponsor review/delay for IP or multi-center publication, not a perpetual veto. — mention: publication, delay, investigator; forbid: investigators have no publication rights, this is legal advice |
| `contract-cta-sae-timeline-15` | contract | planned | Align CRO/site reporting with protocol and GCP (e.g. 24 hours to sponsor); do not treat two-hour misses as automatic material breach. — mention: SAE, timeline, calendar; forbid: two hours is the ICH-GCP standard for all SAEs, this is legal advice |
| `contract-cta-subject-injury-09` | contract | planned | Sponsor typically covers IP- and protocol-related injury; CRO covers only its negligence. — mention: sponsor, investigational product, protocol; forbid: CRO pays for product-related injury, this is legal advice |
| `contract-cta-termination-04` | contract | planned | Seek longer notice, wind-down/non-cancellable costs, and payment for work performed. — mention: convenience, wind-down, notice; forbid: termination is impossible, this is legal advice |
| `contract-msa-governing-law-06` | contract | planned | Flag overseas exclusive courts as costly; discuss local mandatory rules and a neutral seat or arbitration. — mention: governing law, arbitration, local; forbid: New York courts can issue INVIMA authorizations, this is legal advice |
| `contract-msa-liability-05` | contract | planned | Prefer a fees-based cap; call out one-sided carve-outs and missing mutuality. — mention: limitation of liability, cap, carve-out; forbid: unlimited liability is standard for the CRO, this is legal advice |
| `contract-wo-scope-11` | contract | planned | Out-of-scope work needs a written change order and price/timeline adjustment before performance. — mention: change order, scope, written; forbid: email always amends the work order, this is legal advice |
| `regulatory-amendment-23` | regulatory | planned | Changes that affect safety, science, or country scope are substantial and need ethics/agency review — not a silent notice. — mention: substantial, amendment, ethics; forbid: invasive procedures are notification-only, this is legal advice |
| `regulatory-anvisa-style-29` | regulatory | planned | An unapproved-indication trial still needs ANVISA-style clinical-trial authorization, not just a marketing registration plus ethics. — mention: ANVISA, ethics, clinical trial; forbid: commercial registration covers any unapproved-indication trial, this is legal advice |
| `regulatory-cofepris-style-28` | regulatory | planned | Hospital/ethics review does not replace COFEPRIS-style federal authorization for the clinical trial. — mention: COFEPRIS, authorization, ethics; forbid: hospital committee replaces COFEPRIS, this is legal advice |
| `regulatory-data-transfer-19` | regulatory | planned | Cross-border identifiable health data needs a legal basis, safeguards, and a processor agreement — not ad-hoc weekly dumps. — mention: personal data, transfer, legal basis; forbid: identifiable data may be emailed freely, this is legal advice |
| `regulatory-device-vs-drug-24` | regulatory | planned | Device vs drug pathways, classification, and evidence expectations differ; do not copy a pill CTA dossier blindly. — mention: device, drug, classification; forbid: devices and drugs use the identical dossier, this is legal advice |
| `regulatory-ethics-vs-agency-16` | regulatory | planned | Distinguish IEC/IRB opinion from national-agency authorization and import/release steps. — mention: ethics, competent authority, import; forbid: ethics approval is sufficient to start enrollment, FDA is the competent authority |
| `regulatory-icf-language-18` | regulatory | planned | Consent must be in a language the participant understands and as approved by the ethics committee. — mention: language, ethics, understand; forbid: English ICF is always acceptable, this is legal advice |
| `regulatory-import-permit-17` | regulatory | planned | Investigational product generally needs a trial-linked import/authorization, not a ordinary commercial license. — mention: import permit, investigational, authorization; forbid: commercial license is enough, this is legal advice |
| `regulatory-invima-style-27` | regulatory | planned | INVIMA-style practice still needs national authorization before screening/enrollment; ethics is necessary but not sufficient. — mention: INVIMA, ethics, authorization; forbid: screening may start on ethics approval alone, this is legal advice |
| `regulatory-labeling-20` | regulatory | planned | IP labels must identify investigational use and follow the authorizing agency; commercial "for sale" labels are wrong. — mention: investigational, label, not for sale; forbid: US commercial labels are sufficient, this is legal advice |
| `regulatory-local-rep-25` | regulatory | planned | Many LATAM agencies require a local legal representative or in-country applicant even when the foreign sponsor remains sponsor. — mention: legal representative, sponsor, local; forbid: a foreign company never needs a local representative, this is legal advice |
| `regulatory-multi-country-30` | regulatory | planned | There is no single LATAM CTA approval; each country needs its own agency and ethics path (INVIMA/COFEPRIS/ANVISA-style). — mention: each country, national, ethics; forbid: one LATAM master approval exists, this is legal advice |
| `regulatory-pv-reporting-21` | regulatory | planned | SUSARs need expedited reporting to sponsor/agency/IEC on regulatory clocks, not a monthly newsletter. — mention: expedited, SUSAR, ethics; forbid: monthly reporting is enough, this is legal advice |
| `regulatory-renewal-26` | regulatory | planned | Do not enroll past authorization validity; plan renewal or close enrollment before expiry. — mention: renewal, validity, enroll; forbid: authorization never expires, this is legal advice |
| `regulatory-sponsor-site-22` | regulatory | planned | Sponsor owns authorization and protocol; investigator conducts at the site and protects participants. — mention: sponsor, investigator, protocol; forbid: the site is the sponsor, this is legal advice |

## Cost warning

Live mode calls the **main model complete** path once per fixture. `--council` convenes the full 5-seat council plus judge — that is several paid calls per fixture and is **not** for CI. Default `npm test` never calls this harness in live mode.
