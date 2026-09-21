# Lyman Materials

A checkout board for shared Lyman gear (coolers, frisbees, the ice cream machine, the projector, …).

**Live site:** https://ankushdhawan5812.github.io/lyman-materials/

- Residents see what's available now, what's checked out (and when it's due back), and upcoming reservations. Names and emails are never shown publicly.
- They request an item with a pickup date and a loan length. Overlapping dates are blocked.
- Each request lands in a Google Sheet and emails **ankushd@stanford.edu** (reply goes straight to the borrower). The borrower gets a confirmation.
- Every morning a reminder email goes to anyone who still has an item **7 days after pickup**.
- When something comes back, set its **Status** to `Returned` in the sheet. That frees the item on the site and stops reminders.

## How it fits together

```
GitHub Pages (index.html, app.js)  ──GET items / POST request──▶  Google Apps Script web app (apps-script/Code.gs)
                                                                        │
                                                                        ├─ Google Sheet: "Items" + "Requests" tabs
                                                                        ├─ MailApp: request + confirmation emails
                                                                        └─ Daily 9am trigger: return reminders
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
| `REMINDER_DAYS_AFTER_PICKUP` | `7` | When the return reminder goes out |
| `MAX_DAYS` | `14` | Longest loan someone can request |
| `MAX_DAYS_AHEAD` | `90` | How far ahead someone can reserve |
| `SEND_CONFIRMATION_TO_BORROWER` | `true` | Email the borrower when they submit |

After editing the code in the Apps Script editor, use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. That keeps the same URL, so `config.js` doesn't change. If you change `REMINDER_HOUR`, run `setup` again to reschedule the trigger.
