# Terms of Use — Altimate Code plugin for Claude Code

**Effective date:** July 9, 2026

These terms cover your use of the `altimate-code` Claude Code plugin distributed from this repository ("the Plugin"). They supplement — and where services are involved, incorporate — the Altimate AI [Terms & Conditions](https://www.altimate.ai/terms) and [Privacy Policy](https://www.altimate.ai/privacy).

## 1. What you're licensing

The Plugin's source code is open source under the **MIT License** (see [LICENSE](./LICENSE)). You may use, copy, modify, and redistribute it under those terms. The MIT License governs the code; these terms govern your use of the connected Altimate services.

## 2. What the Plugin does

The Plugin instructs Claude Code to delegate data-engineering tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI installed on your machine. The CLI may, at your configuration, use the Altimate LLM Gateway or an LLM provider you supply. Use of the Altimate LLM Gateway and other Altimate-operated services is governed by the Altimate [Terms & Conditions](https://www.altimate.ai/terms).

## 3. Your responsibilities

- **Credentials and access.** Warehouse connections run locally under credentials you supply. You are responsible for the scope of those credentials and for complying with your organization's data access policies. We recommend read-only credentials (or the CLI's read-only Analyst mode) for exploratory work against production systems.
- **Reviewing agent output.** The Plugin invokes an autonomous agent in non-interactive mode (`--yolo`), meaning the CLI's permission prompts are auto-approved for the delegated task. You are responsible for reviewing generated SQL, dbt changes, and file edits before deploying them. Destructive SQL statements (`DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`) are hard-blocked by the CLI, but this is a safety net, not a substitute for review.
- **Third-party terms.** Your use of Claude Code is governed by Anthropic's terms. Your use of a BYOK LLM provider is governed by that provider's terms. Your use of your data warehouse is governed by your warehouse vendor's terms.
- **Lawful use.** You may not use the Plugin to violate applicable law, third-party rights, or the acceptable-use terms of any connected service.

## 4. No warranty

The Plugin is provided **"as is," without warranty of any kind**, as stated in the MIT License. Without limiting that: outputs of AI systems can be incorrect; SQL analysis, lineage, cost estimates, and generated code are provided for your evaluation and are not a substitute for your own testing and review.

## 5. Limitation of liability

To the fullest extent permitted by law, the entire liability of Altimate Inc. and its suppliers under these terms is limited to the amount you actually paid for the connected Altimate services, or 100 USD if you have not purchased anything, consistent with the limitation of liability in the Altimate [Terms & Conditions](https://www.altimate.ai/terms). Some jurisdictions do not allow certain exclusions or limitations, in which case liability is limited to the greatest extent permitted by law.

## 6. Changes and termination

We may update the Plugin, these terms, or discontinue the Plugin's distribution at any time. Continued use after an update constitutes acceptance. You can stop using the Plugin at any time by disabling or uninstalling it (`claude plugin disable altimate-code@altimate-claude-plugin`).

## 7. Governing law and disputes

These terms are governed by the laws of the State of California, United States, excluding its conflicts of law rules, consistent with the Altimate [Terms & Conditions](https://www.altimate.ai/terms). If you have a concern or dispute, you agree to first try to resolve it informally by contacting us. If you are a European Union consumer, you benefit from any mandatory provisions of the law of the country in which you are resident.

## 8. Contact

Altimate Inc. · 440 North Wolfe Road #150, Sunnyvale, CA 94085, USA
Support: **support@altimate.ai** · Legal & privacy inquiries: **info@altimate.ai**
