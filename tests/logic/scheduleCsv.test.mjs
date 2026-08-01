import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCsv, readCsvText, isHomeBased, isOnlineClientHome } = require('../../api/mc/scheduleCsv.js');

const HEADERS = [
  'Event_Title', 'Start_Date', 'Start_Time', 'End_Date', 'End_Time',
  'Event_URL', 'Workflow_State', 'Location_Address', 'Location_Business_Name',
  'Location_City_State_ZIP', 'Tags', 'Categories', 'Excerpt', 'Text_Block',
  'Updated', 'Published',
].join(',');

/** Kenilworth row with a quoted address containing commas (the failure signature). */
const KENILWORTH = [
  'Long Exposure Photography Workshop - Kenilworth 01-09',
  '2026-09-01', '18:00:00', '2026-09-01', '20:00:00',
  'https://example.com/kenilworth', 'Published',
  '"Castle Hill, Kenilworth, England, CV8 1ND, United Kingdom"',
  'Kenilworth', 'CV8 1ND', '', '', '', '', '2026-06-01 10:00:00', 'Published',
].join(',');

/**
 * Christmas Warwickshire-style row: Text_Block is multi-line HTML with commas
 * and doubled quotes — the exact case that broke line-first parsing.
 */
const HTML_BLOCK = [
  'Christmas Workshop - Warwickshire 10 Dec',
  '2026-12-10', '10:00:00', '2026-12-10', '16:00:00',
  'https://example.com/xmas', 'Published',
  '"Some Venue, Warwick, England"',
  'Warwick', 'CV34 1AA', '', '', '',
  `"<div class=""sqs-html-content"">
  <h3 style=""white-space:pre-wrap;""><strong>Location - Warwickshire</strong></h3>
  <p>Meet at Castle Hill, Kenilworth, before dusk.</p>
</div>"`,
  '2026-06-14 13:04:25', 'Published',
].join(',');

describe('scheduleCsv — RFC-4180 parser', () => {
  it('keeps Kenilworth Start_Date as a real date (quoted address with commas)', () => {
    const { rows } = readCsvText(`${HEADERS}\n${KENILWORTH}\n`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Start_Date, '2026-09-01');
    assert.equal(rows[0].Location_Business_Name, 'Kenilworth');
    assert.match(rows[0].Location_Address, /Castle Hill, Kenilworth/);
    // The old bug: slice(0,10) of " Kenilworth" → " Kenilwort"
    assert.notEqual(String(rows[0].Start_Date).slice(0, 10), ' Kenilwort');
  });

  it('keeps Start_Date intact when Text_Block is multi-line HTML with quotes', () => {
    const { rows } = readCsvText(`${HEADERS}\n${HTML_BLOCK}\n`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Event_Title, 'Christmas Workshop - Warwickshire 10 Dec');
    assert.equal(rows[0].Start_Date, '2026-12-10');
    assert.match(rows[0].Text_Block, /sqs-html-content/);
    assert.match(rows[0].Text_Block, /Castle Hill, Kenilworth/);
    assert.equal(rows[0].Workflow_State || rows[0].Published || 'Published', 'Published');
  });

  it('honours doubled-quote escaping inside a field', () => {
    const records = parseCsv('a,"say ""hi"", friend",c\n');
    assert.deepEqual(records[0], ['a', 'say "hi", friend', 'c']);
  });

  it('parses the live workshops CSV with no Kenilwort-style Start_Date', () => {
    const path = 'G:/Dropbox/alan ranger photography/Website Code/alan-shared-resources/csv/03-photographic-workshops-near-me.csv';
    if (!fs.existsSync(path)) {
      // Skip quietly when the shared CSV isn't on this machine.
      return;
    }
    const { rows } = readCsvText(fs.readFileSync(path, 'utf8'));
    const kenil = rows.find((r) => String(r.Event_Title || '').includes('Kenilworth 01-09'));
    assert.ok(kenil, 'Kenilworth 01-09 row present');
    assert.equal(kenil.Start_Date.slice(0, 10), '2026-09-01');
    const bad = rows.filter((r) => r.Event_Title && !/^\d{4}-\d{2}-\d{2}/.test(String(r.Start_Date || '')));
    assert.equal(bad.length, 0, `bad Start_Date rows: ${bad.slice(0, 3).map((r) => r.Start_Date).join('|')}`);
  });
});

describe('scheduleCsv — online client = home buffers', () => {
  it('treats Zoom 1-2-1 / mentoring as home', () => {
    assert.equal(isOnlineClientHome('Myra Little: Online 1-2-1 Tuition - Zoom'), true);
    assert.equal(isOnlineClientHome('Caroline Key: Monthly Mentoring Feedback - Zoom'), true);
    assert.equal(isOnlineClientHome('Peak District Photography Workshop'), false);
    assert.equal(isHomeBased({
      title: 'Myra Little: Online 1-2-1 Tuition - Zoom',
      address: '', postcode: '', location_name: '',
    }, 'CV4 9HW'), true);
    assert.equal(isHomeBased({
      title: 'Away Workshop', address: 'Buxton', postcode: 'SK17', location_name: 'Peak',
    }, 'CV4 9HW'), false);
  });
});
