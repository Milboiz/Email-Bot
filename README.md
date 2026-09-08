# Ops Assistant

An AI-powered back-office assistant for solo freelancers and agencies running cold outreach.
Single static page, no backend, no build step — deployed to GitHub Pages at
**https://milboiz.github.io/Email-Bot/**

Bring your own Gmail OAuth consent and Anthropic API key; everything is stored in your own
browser's `localStorage` and nothing is sent to any server other than Google and Anthropic.

## What it does

| Tab | Purpose |
|---|---|
| **Campaign** | Who you are, what you sell, tone, and the follow-up threshold |
| **Contacts** | CSV import, paste-anything AI extraction, manual entry |
| **Emails** | Batch-generated personalised cold emails; review, edit, regenerate, send |
| **Sent** | Durable dashboard of every send, reply, and follow-up |
| **Follow-ups** | Contacts who went quiet past your threshold, with AI-drafted nudges |
| **Replies** | Every reply, one-line summarised and tagged, Interested pinned to the top |
| **Call Prep** | A short brief to read right before you dial a prospect |

### Follow-up nudges

Surfaces any contact with no reply after N **business days** (default 5, configurable in
Campaign — weekends are skipped, so a Friday send comes due the following Friday rather than
mid-week). Drafts a short, non-guilt-tripping follow-up with Claude, which you review and edit
before sending. Follow-ups send as a genuine reply in the original Gmail thread
(`threadId` + `In-Reply-To`/`References`), not as a fresh email.

Contacts are never nudged once they have replied, or once their reply is tagged
**Unsubscribe**, **Not Interested**, **Wrong Person**, or **Referral**.

### Inbox triage

Replies are detected by polling the Gmail threads of sent emails every 5 minutes. Each reply's
full body — not just the snippet — is fetched and classified by Claude into one of eight
categories, with a one-line summary:

`Interested` · `Question` · `Referral` · `Not Interested` · `Wrong Person` · `Unsubscribe` · `Auto-Reply` · `Other`

Polling resumes automatically on page load, so replies are still picked up after you close and
reopen the tab.

## Setup

One-time, in the app's **Setup** tab:

1. **Anthropic API key** — from [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys. Add a small credit balance.
2. **Google Cloud OAuth client** — create a project, enable the **Gmail API**, add yourself as a
   test user on the OAuth consent screen, then create a **Web application** OAuth client ID with
   `https://milboiz.github.io` as an authorized JavaScript origin.

Scopes used: `gmail.send`, `gmail.readonly`, `userinfo.email`.

### Running locally

OAuth popups need a real origin, so open it over HTTP rather than `file://`:

```sh
python3 -m http.server 8080
```

Then visit `http://localhost:8080/index.html` and add `http://localhost:8080` as an authorized
JavaScript origin in the Google Cloud console.

## Data

Everything lives in `localStorage` under `eob_*` keys:

| Key | Contents |
|---|---|
| `eob_apiKey`, `eob_clientId`, `eob_userEmail` | Credentials and identity |
| `eob_campaign` | Sender name, product, tone, subject hint, `followUpDays` |
| `eob_contacts` | Imported contacts |
| `eob_sentHistory` | One durable record per send: timestamps, `threadId`, status, reply, triage, follow-up count |

**Setup → Clear all saved data** removes all of it.

## Tests

The app ships as a single dependency-free `index.html`. The checks in `test/` are optional and
dev-only — they compile the JSX, unit-test the pure helpers (business-day maths, CSV parsing,
MIME body extraction, JSON extraction, MIME header construction), and mount the real component
in jsdom to walk every tab.

```sh
cd test && npm install && npm test
```

## Model

Claude is called directly from the browser via the `anthropic-dangerous-direct-browser-access`
header. The model is set by the `MODEL` constant near the top of the script block in
`index.html` — currently `claude-sonnet-4-6`.
