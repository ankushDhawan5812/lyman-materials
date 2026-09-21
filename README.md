# Lyman Materials

A checkout board for shared gear at the Richard W. Lyman Graduate Residences, Stanford (coolers, frisbees, the ice cream machine, the projector, …). Styled with Stanford's colors and typefaces. The emblem is the 60-foot oak at the center of the Lyman commons.

**Live site:** https://ankushdhawan5812.github.io/lyman-materials/

- Residents see what's available now, what's checked out (and when it's due back), and upcoming reservations. Names and emails are never shown publicly.
- They request an item with a pickup date and a loan length. Overlapping dates are blocked.
- Each request lands in a Google Sheet and emails **ankushd@stanford.edu** (reply goes straight to the borrower). The borrower gets a confirmation.
- Borrowers who still have an item get two automatic emails, both at 9am:
  - **The day after pickup:** "Hope your event went well!" plus the return date.
  - **7 days after pickup:** a return reminder.
  If a daily run is ever missed, only the most recent one that's due is sent, so nobody gets a stale "hope it went well" note.
- When something comes back, set its **Status** to `Returned` in the sheet. That frees the item on the site and stops reminders.

## How it fits together

```
GitHub Pages (index.html, app.js)  ──GET items / POST request──▶  Google Apps Script web app (apps-script/Code.gs)
                                                                        │
                                                                        ├─ Google Sheet: "Items" + "Requests" tabs
                                                                        ├─ MailApp: request + confirmation emails
                                                                        └─ Daily 9am trigger: day-after note + 1-week reminder
```

GitHub Pages can only serve static files, so the Apps Script handles storage and email. It's free and runs under your Google account.

## One-time setup (about 5 minutes)

1. Go to [script.google.com](https://script.google.com) and click **New project**. Rename it "Lyman Materials".
2. Delete everything in `Code.gs` and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs). Save (⌘S).
3. In the function dropdown at the top, choose **`setup`** and click **Run**.
   - Google will ask for permission. Click **Review permissions**, pick your account, then **Advanced → Go to Lyman Materials (unsafe)** → **Allow**. ("Unsafe" just means Google hasn't reviewed your personal script.)
   - This creates a Google Sheet called **"Lyman Materials — Checkout Log"** in your Drive and schedules the daily reminder. The execution log prints the sheet's link.
4. Click **Deploy → New deployment**. Click the gear icon and choose **Web app**, then set:
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Open [`config.js`](config.js), paste the URL into `apiUrl`, and commit. The site goes live within a minute. Until then it shows sample data with a "Preview mode" banner.

> **If "Anyone" isn't offered** (some university Google accounts block it), do steps 1–4 with a personal Gmail account instead. Emails will come *from* that account, but replies still go to ankushd@stanford.edu.

## Day-to-day

| To… | Do this in the Google Sheet |
| --- | --- |
| Mark an item returned | **Requests** tab → set **Status** to `Returned` |
| Decline or cancel a request | Set **Status** to `Cancelled` (frees those dates) |
| Add, rename, or remove an item | **Items** tab → edit the rows (the description is optional and shows on the site) |
| Change dates on a booking | Edit **Pickup date** / **Return by** (format `YYYY-MM-DD`) |

## Changing settings

Loan limits, reminder timing, and email text live in the `CONFIG` block at the top of `apps-script/Code.gs`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ADMIN_EMAIL` | `ankushd@stanford.edu` | Where new requests are sent |
| `DAY_AFTER_NOTE_DAYS` | `1` | When the "hope it went well" note goes out (`0` turns it off) |
| `REMINDER_DAYS_AFTER_PICKUP` | `7` | When the return reminder goes out (`0` turns it off) |
| `MAX_DAYS` | `14` | Longest loan someone can request |
| `MAX_DAYS_AHEAD` | `90` | How far ahead someone can reserve |
| `SEND_CONFIRMATION_TO_BORROWER` | `true` | Email the borrower when they submit |

If you set this up with an earlier version, paste in the new `Code.gs` and redeploy (below). The new **Day-after note sent** column is added to your sheet automatically.

After editing the code in the Apps Script editor, use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. That keeps the same URL, so `config.js` doesn't change. If you change `REMINDER_HOUR`, run `setup` again to reschedule the trigger.
