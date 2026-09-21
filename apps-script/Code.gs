/**
 * Lyman Materials — backend (Google Apps Script)
 *
 * - Stores the item list and every checkout request in a Google Sheet.
 * - doGet  → returns items + active bookings to the website (no names/emails).
 * - doPost → records a new request and emails the community associate.
 * - sendReminders (daily trigger) → emails borrowers a week after pickup.
 *
 * To mark something returned, open the sheet and set the request's Status to "Returned".
 * See README.md for setup.
 */

const CONFIG = {
  ADMIN_EMAIL: 'ankushd@stanford.edu',
  SITE_NAME: 'Lyman Materials',
  SITE_URL: 'https://ankushdhawan5812.github.io/lyman-materials/',
  TIMEZONE: 'America/Los_Angeles',
  REMINDER_DAYS_AFTER_PICKUP: 7, // reminder email goes out this many days after the pickup date
  REMINDER_HOUR: 9,              // local hour the daily reminder check runs
  MAX_DAYS: 14,                  // longest loan someone can request
  MAX_DAYS_AHEAD: 90,            // how far in advance someone can reserve
  SEND_CONFIRMATION_TO_BORROWER: true,
};

const DEFAULT_ITEMS = [
  ['Cooler', ''],
  ['Frisbee', ''],
  ['Ice cream machine', ''],
  ['Projector', ''],
];

const ITEM_HEADERS = ['Item', 'Description'];
const REQUEST_HEADERS = [
  'ID', 'Submitted', 'Item', 'Name', 'Email', 'Unit',
  'Pickup date', 'Return by', 'Days', 'Notes', 'Status', 'Reminder sent',
];
const STATUS = { ACTIVE: 'Active', RETURNED: 'Returned', CANCELLED: 'Cancelled' };

class UserError extends Error {}

// ---------------------------------------------------------------------------
// One-time setup: run this from the Apps Script editor.
// ---------------------------------------------------------------------------

function setup() {
  const ss = getSpreadsheet_(true);
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  if (!ss.getSheetByName('Items')) {
    const first = ss.getSheets()[0];
    const items = first.getLastRow() === 0 ? first.setName('Items') : ss.insertSheet('Items');
    items.getRange(1, 1, 1, ITEM_HEADERS.length).setValues([ITEM_HEADERS]);
    items.getRange(2, 1, DEFAULT_ITEMS.length, ITEM_HEADERS.length).setValues(DEFAULT_ITEMS);
    styleHeader_(items);
    items.setColumnWidth(1, 220);
    items.setColumnWidth(2, 420);
  }

  if (!ss.getSheetByName('Requests')) {
    const requests = ss.insertSheet('Requests');
    requests.getRange(1, 1, 1, REQUEST_HEADERS.length).setValues([REQUEST_HEADERS]);
    styleHeader_(requests);
    const body = requests.getRange(2, 1, requests.getMaxRows() - 1, REQUEST_HEADERS.length);
    body.setNumberFormat('@'); // keep dates as plain YYYY-MM-DD text
    requests.getRange(2, REQUEST_HEADERS.indexOf('Status') + 1, requests.getMaxRows() - 1, 1)
      .setDataValidation(statusRule_());
    addStatusColors_(requests);
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendReminders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendReminders')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.REMINDER_HOUR)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  Logger.log('All set. Your checkout log: ' + ss.getUrl());
}

// ---------------------------------------------------------------------------
// Web app endpoints
// ---------------------------------------------------------------------------

function doGet() {
  try {
    const requests = requestTable_().rows.filter(isActive_);
    const items = readItems_().map(item => ({
      name: item.name,
      description: item.description,
      bookings: requests
        .filter(r => sameItem_(r.item, item.name) && r.start && r.end)
        .map(r => ({ start: r.start, end: r.end }))
        .sort((a, b) => a.start.localeCompare(b.start)),
    }));
    return json_({
      ok: true,
      today: today_(),
      maxDays: CONFIG.MAX_DAYS,
      maxDaysAhead: CONFIG.MAX_DAYS_AHEAD,
      items,
    });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Could not load items.' });
  }
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Invalid request.' });
  }
  if (data.website) return json_({ ok: true }); // honeypot field: only bots fill it in

  const lock = LockService.getScriptLock();
  let record;
  try {
    lock.waitLock(15000);
    record = createRequest_(data);
  } catch (err) {
    if (err instanceof UserError) return json_({ ok: false, error: err.message });
    console.error(err);
    return json_({
      ok: false,
      error: 'Something went wrong on our end. Please try again, or email ' + CONFIG.ADMIN_EMAIL + '.',
    });
  } finally {
    lock.releaseLock();
  }

  try {
    notifyAdmin_(record);
    if (CONFIG.SEND_CONFIRMATION_TO_BORROWER) confirmToBorrower_(record);
  } catch (err) {
    console.error('Email failed for ' + record.id + ': ' + err);
  }
  return json_({ ok: true, id: record.id, item: record.item, start: record.start, end: record.end });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function createRequest_(data) {
  const today = today_();
  const name = oneLine_(data.name, 100);
  const email = oneLine_(data.email, 200).toLowerCase();
  const unit = oneLine_(data.unit, 40);
  const notes = String(data.notes == null ? '' : data.notes).trim().slice(0, 1000);
  const start = oneLine_(data.start, 10);
  const days = Number(data.days);

  if (!name) throw new UserError('Please enter your name.');
  if (!isEmail_(email)) throw new UserError('Please enter a valid email address.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || addDays_(start, 0) !== start) {
    throw new UserError('Please choose a pickup date.');
  }
  if (start < today) throw new UserError('The pickup date can’t be in the past.');
  if (start > addDays_(today, CONFIG.MAX_DAYS_AHEAD)) {
    throw new UserError('You can reserve up to ' + CONFIG.MAX_DAYS_AHEAD + ' days ahead.');
  }
  if (!Number.isInteger(days) || days < 1 || days > CONFIG.MAX_DAYS) {
    throw new UserError('Loans can be 1 to ' + CONFIG.MAX_DAYS + ' days long.');
  }

  const item = readItems_().find(i => sameItem_(i.name, data.item));
  if (!item) throw new UserError('Please choose an item from the list.');
  const end = addDays_(start, days);

  const table = requestTable_();
  // An item that's overdue is still out today, so treat its booking as running until today.
  const clash = table.rows.find(r =>
    isActive_(r) && sameItem_(r.item, item.name) && r.start && r.end &&
    start <= maxYmd_(r.end, today) && end >= r.start);
  if (clash) {
    throw new UserError('Sorry — the ' + item.name + ' is already booked ' + fmt_(clash.start) +
      ' to ' + fmt_(clash.end) + '. Please pick different dates.');
  }

  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('NEXT_ID') || 1);
  props.setProperty('NEXT_ID', String(n + 1));

  const record = {
    id: 'LM-' + String(n).padStart(4, '0'),
    submitted: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'),
    item: item.name, name, email, unit, start, end, days, notes,
    status: STATUS.ACTIVE,
  };
  const byHeader = {
    'ID': record.id, 'Submitted': record.submitted, 'Item': record.item, 'Name': name,
    'Email': email, 'Unit': unit, 'Pickup date': start, 'Return by': end, 'Days': String(days),
    'Notes': notes, 'Status': STATUS.ACTIVE, 'Reminder sent': '',
  };

  const sheet = table.sheet;
  record.row = sheet.getLastRow() + 1;
  const range = sheet.getRange(record.row, 1, 1, table.headers.length);
  range.setNumberFormat('@');
  range.setValues([table.headers.map(h => safeCell_(h in byHeader ? byHeader[h] : ''))]);
  if (table.col.Status != null) {
    sheet.getRange(record.row, table.col.Status + 1).setDataValidation(statusRule_());
  }
  record.sheetLink = sheet.getParent().getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + record.row;
  return record;
}

/** Daily trigger: remind anyone who still has an item a week after pickup. */
function sendReminders() {
  const today = today_();
  const table = requestTable_();
  const due = table.rows.filter(r =>
    isActive_(r) && !r.reminderSent && r.start && isEmail_(r.email) &&
    addDays_(r.start, CONFIG.REMINDER_DAYS_AFTER_PICKUP) <= today);

  due.forEach(r => {
    try {
      remindBorrower_(r, today);
      table.sheet.getRange(r.row, table.col['Reminder sent'] + 1)
        .setValue(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'));
    } catch (err) {
      console.error('Reminder failed for ' + r.id + ': ' + err);
    }
  });
  Logger.log('Sent ' + due.length + ' reminder(s).');
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

function notifyAdmin_(r) {
  MailApp.sendEmail({
    to: CONFIG.ADMIN_EMAIL,
    replyTo: r.email,
    name: CONFIG.SITE_NAME,
    subject: 'New request: ' + r.item + ' — ' + r.name + ' (' + fmt_(r.start) + ' to ' + fmt_(r.end) + ')',
    htmlBody: emailHtml_(
      'New checkout request',
      '<p style="margin:0 0 4px">' + esc_(r.name) + ' wants to borrow the <b>' + esc_(r.item) + '</b>. ' +
        'Reply to this email to reach them directly.</p>',
      [
        ['Request', esc_(r.id)],
        ['Item', esc_(r.item)],
        ['Name', esc_(r.name)],
        ['Email', '<a href="mailto:' + esc_(r.email) + '">' + esc_(r.email) + '</a>'],
        ['Unit', esc_(r.unit)],
        ['Pickup', esc_(fmt_(r.start))],
        ['Return by', esc_(fmt_(r.end)) + ' (' + r.days + (r.days === 1 ? ' day)' : ' days)')],
        ['Notes', esc_(r.notes).replace(/\n/g, '<br>')],
      ],
      '<p>When it comes back, set the Status to <b>Returned</b> in the ' +
        '<a href="' + r.sheetLink + '" style="color:#8c1515">checkout log</a>. ' +
        'To turn the request down, set it to <b>Cancelled</b> so the dates free up.</p>'
    ),
  });
}

function confirmToBorrower_(r) {
  MailApp.sendEmail({
    to: r.email,
    replyTo: CONFIG.ADMIN_EMAIL,
    name: CONFIG.SITE_NAME,
    subject: 'Request received: ' + r.item + ' (' + fmt_(r.start) + ')',
    htmlBody: emailHtml_(
      'We got your request',
      '<p style="margin:0 0 4px">Hi ' + esc_(firstName_(r.name)) + ', your request for the <b>' +
        esc_(r.item) + '</b> is in. The Lyman community associate will follow up about pickup.</p>',
      [
        ['Request', esc_(r.id)],
        ['Pickup', esc_(fmt_(r.start))],
        ['Return by', esc_(fmt_(r.end))],
      ],
      '<p>Questions or change of plans? Just reply to this email.</p>'
    ),
  });
}

function remindBorrower_(r, today) {
  let when;
  if (r.end < today) when = 'was due back on <b>' + esc_(fmt_(r.end)) + '</b>. Please return it as soon as you can.';
  else if (r.end === today) when = 'is due back <b>today</b>. Please return it when you’re done.';
  else when = 'is due back on <b>' + esc_(fmt_(r.end)) + '</b>. Please return it by then.';

  MailApp.sendEmail({
    to: r.email,
    replyTo: CONFIG.ADMIN_EMAIL,
    name: CONFIG.SITE_NAME,
    subject: 'Reminder: please return the ' + r.item,
    htmlBody: emailHtml_(
      'Friendly reminder',
      '<p style="margin:0 0 4px">Hi ' + esc_(firstName_(r.name)) + ', the <b>' + esc_(r.item) +
        '</b> you picked up on ' + esc_(fmt_(r.start)) + ' ' + when + '</p>',
      [],
      '<p>Reply to this email to set up a drop-off. If you’ve already returned it, thank you — you can ignore this note.</p>'
    ),
  });
}

function emailHtml_(title, intro, rows, outro) {
  const cells = rows.filter(row => row[1]).map(row =>
    '<tr><td style="padding:6px 20px 6px 0;color:#6b645d;vertical-align:top;white-space:nowrap">' + esc_(row[0]) +
    '</td><td style="padding:6px 0">' + row[1] + '</td></tr>').join('');
  const site = CONFIG.SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;' +
    'font-size:15px;line-height:1.55;color:#1c1917;max-width:560px">' +
    '<h2 style="font-size:20px;margin:0 0 12px;color:#8c1515">' + esc_(title) + '</h2>' +
    intro +
    (cells ? '<table style="border-collapse:collapse;margin:12px 0 4px">' + cells + '</table>' : '') +
    (outro || '') +
    '<p style="color:#6b645d;font-size:13px;margin-top:24px">' + esc_(CONFIG.SITE_NAME) + ' · ' +
    '<a href="' + CONFIG.SITE_URL + '" style="color:#8c1515">' + esc_(site) + '</a></p></div>';
}

// ---------------------------------------------------------------------------
// Sheet access
// ---------------------------------------------------------------------------

function getSpreadsheet_(createIfMissing) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  if (!createIfMissing) throw new Error('No sheet yet. Run setup() in the Apps Script editor first.');
  const ss = SpreadsheetApp.create(CONFIG.SITE_NAME + ' — Checkout Log');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function readItems_() {
  const values = getSpreadsheet_().getSheetByName('Items').getDataRange().getValues();
  values.shift();
  return values
    .map(r => ({ name: String(r[0]).trim(), description: String(r[1] == null ? '' : r[1]).trim() }))
    .filter(i => i.name);
}

/** Reads the Requests tab by header name, so columns can be reordered or added. */
function requestTable_() {
  const sheet = getSpreadsheet_().getSheetByName('Requests');
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });
  const cell = (row, h) => (col[h] == null ? '' : row[col[h]]);

  const rows = values.map((row, i) => ({
    row: i + 2,
    id: String(cell(row, 'ID')),
    item: String(cell(row, 'Item')).trim(),
    name: String(cell(row, 'Name')).trim(),
    email: String(cell(row, 'Email')).trim(),
    start: toYmd_(cell(row, 'Pickup date')),
    end: toYmd_(cell(row, 'Return by')),
    status: String(cell(row, 'Status')).trim(),
    reminderSent: String(cell(row, 'Reminder sent')).trim(),
  })).filter(r => r.item);

  return { sheet, headers, col, rows };
}

function isActive_(r) {
  const s = r.status.toLowerCase();
  return s !== STATUS.RETURNED.toLowerCase() && s !== STATUS.CANCELLED.toLowerCase();
}

function statusRule_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList([STATUS.ACTIVE, STATUS.RETURNED, STATUS.CANCELLED], true)
    .setAllowInvalid(false)
    .build();
}

function styleHeader_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .setFontWeight('bold').setBackground('#8c1515').setFontColor('#ffffff');
}

function addStatusColors_(sheet) {
  const col = REQUEST_HEADERS.indexOf('Status') + 1;
  const range = sheet.getRange(2, col, sheet.getMaxRows() - 1, 1);
  const rule = (text, bg, fg) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setRanges([range]).build();
  sheet.setConditionalFormatRules([
    rule(STATUS.ACTIVE, '#fbefd9', '#8a5300'),
    rule(STATUS.RETURNED, '#e3f2e8', '#17693c'),
    rule(STATUS.CANCELLED, '#eeeeee', '#777777'),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers (dates are YYYY-MM-DD strings, which compare correctly as text)
// ---------------------------------------------------------------------------

function today_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function addDays_(ymd, n) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

function toYmd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim();
}

function maxYmd_(a, b) {
  return a > b ? a : b;
}

/** "2026-09-21" → "Mon, Sep 21" */
function fmt_(ymd) {
  const p = ymd.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)), 'UTC', 'EEE, MMM d');
}

function sameItem_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function oneLine_(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function firstName_(name) {
  return name.split(' ')[0];
}

/** Stop user text like "=IMPORTXML(...)" from being treated as a formula. */
function safeCell_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
