# Changelog: @odingard/guardian-link

> **DRAFT. Not released. The wording must be approved before any release.** This
> entry moves to the root `CHANGELOG.md` only after the wording is approved.

## DRAFT: guardian-link 0.1.0 (unreleased)

### DRAFT: Added: Stripe Link agent wallet, test mode

- **DRAFT:** **`@odingard/guardian-link` 0.1.0** (new; tested with fakes, not
  yet run against a real Link account): Guardian decides a Stripe Link spend
  request on its exact terms (merchant name and URL, amount, currency, line
  items, totals) before it is created, in Link test mode only. Line items and
  totals must add up to the amount.
  - **DRAFT:** Proposed as `tool.invoke` on `link.spend` (or
    `link.spend.above_cap`). ASK waits for a person; ALLOW is redeemed with
    `execute` before Link is called. After a person approved, the Guardian
    receipt must be for that request and those exact arguments.
  - **DRAFT:** The guard holds the Link login and creates one spend request
    per decision, with `--test` and an idempotency key. What Link created,
    and the request again before Link's approval push and before the card is
    read, must match the decided terms, with no recurring schedule, metadata
    or unknown field; otherwise it is canceled and refused.
  - **DRAFT:** The Link CLI runs by absolute path only (not through PATH or
    npx), from a private folder. The login file must be a `.json` file only
    the guard's user can read, with one hard link, in a folder no one else
    can write to.
  - **DRAFT:** `spend-request update` is a new decision on the full new terms
    and always needs a person. The guard refuses to act while a Link approval
    policy exists or Link answers anything but "No approval policy has been
    configured".
  - **DRAFT:** Stored decisions are checked when read; a store only the
    guard can write to is required for replay protection.
  - **DRAFT:** The card is read once, through `--output-file` into a private
    folder that is deleted when the call ends (folders a crash left behind
    are wiped the next time the adapter is built), and never appears in the
    guard's records and errors.
  - **DRAFT:** A Link card works at any merchant: the merchant and items are
    evidence, not enforced by Link. Decision-gated, not enforced outside the
    guard's process, and not for an agent with its own Link login.
