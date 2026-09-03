import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  flankWindows, clientWorkshopTitle, isClientParent, isoClose,
} = require('../../api/mc/client-buffer-reconcile-lib.js');

describe('client-buffer-reconcile — flank windows', () => {
  it('mirrors fixture Before/After around parent S/E', () => {
    const parent = {
      id: 'abc',
      summary: 'Myra Little: Online 1-2-1 Tuition - Zoom',
      start: { dateTime: '2026-08-13T11:00:00.000Z' },
      end: { dateTime: '2026-08-13T12:00:00.000Z' },
    };
    const win = flankWindows(parent, 30, 30);
    assert.equal(win.prep_start, '2026-08-13T10:30:00.000Z');
    assert.equal(win.prep_end, '2026-08-13T11:00:00.000Z');
    assert.equal(win.decomp_start, '2026-08-13T12:00:00.000Z');
    assert.equal(win.decomp_end, '2026-08-13T12:30:00.000Z');
  });

  it('titles Zoom clients for Prep labels', () => {
    assert.equal(
      clientWorkshopTitle('Jo Galloway: Online 1-2-1 Tuition - Zoom - Weekdays'),
      'Jo Galloway 1-2-1 Zoom',
    );
  });

  it('titles Private 1-2-1 clients (not as Zoom)', () => {
    assert.equal(
      clientWorkshopTitle('jackie evans: 2hr 1-2-1 Anytime Private (Alan Ranger Photography)'),
      'jackie evans 1-2-1 Private',
    );
  });

  it('detects client parents and skips MC events', () => {
    assert.equal(isClientParent({
      summary: 'Jo Galloway: Online 1-2-1 Tuition - Zoom',
      start: { dateTime: '2026-08-12T14:30:00Z' },
    }), true);
    assert.equal(isClientParent({
      summary: 'jackie evans: 2hr 1-2-1 Anytime Private (Alan Ranger Photography)',
      start: { dateTime: '2026-09-08T10:00:00+01:00' },
    }), true);
    assert.equal(isClientParent({
      summary: 'MC ⏳ Prep — Jo Galloway 1-2-1 Zoom',
      start: { dateTime: '2026-08-12T14:00:00Z' },
    }), false);
  });

  it('isoClose tolerates small drift', () => {
    assert.equal(isoClose('2026-08-12T14:00:00Z', '2026-08-12T14:01:00Z', 2), true);
    assert.equal(isoClose('2026-08-12T14:00:00Z', '2026-08-12T14:10:00Z', 2), false);
  });
});
