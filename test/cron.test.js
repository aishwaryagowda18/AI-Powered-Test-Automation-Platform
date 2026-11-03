import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeCron, nextRun, parseCron } from '../server/scheduler/cron.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cron', () => {
  it('parses lists, ranges and steps', () => {
    const c = parseCron('*/15 9-17 * * 1-5');
    assert.deepEqual([...c.minute], [0, 15, 30, 45]);
    assert.equal(c.hour.size, 9);
    assert.deepEqual([...c.dow], [1, 2, 3, 4, 5]);
  });

  it('rejects malformed expressions', () => {
    assert.throws(() => parseCron('* * *'), /5 fields/);
    assert.throws(() => parseCron('60 * * * *'), /minute/);
    assert.throws(() => parseCron('*/0 * * * *'), /step/);
  });

  it('computes the next run strictly after the reference time', () => {
    assert.deepEqual(nextRun('*/15 * * * *', at(2026, 3, 10, 10, 7)), at(2026, 3, 10, 10, 15));
    assert.deepEqual(nextRun('*/15 * * * *', at(2026, 3, 10, 10, 15)), at(2026, 3, 10, 10, 30));
    assert.deepEqual(nextRun('0 2 * * *', at(2026, 3, 10, 3, 0)), at(2026, 3, 11, 2, 0));
  });

  it('handles weekdays, month boundaries and Sunday as 7', () => {
    // 2026-03-13 is a Friday → next weekday 09:00 is Monday the 16th.
    assert.deepEqual(nextRun('0 9 * * 1-5', at(2026, 3, 13, 10, 0)), at(2026, 3, 16, 9, 0));
    assert.deepEqual(nextRun('0 0 1 * *', at(2026, 1, 31, 12, 0)), at(2026, 2, 1, 0, 0));
    assert.deepEqual(nextRun('30 8 * * 7', at(2026, 3, 10)), at(2026, 3, 15, 8, 30));
  });

  it('describes common schedules in plain English', () => {
    assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
    assert.equal(describeCron('0 2 * * *'), 'Daily at 02:00');
    assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
    assert.equal(describeCron('5 4 1 2 *'), 'Cron: 5 4 1 2 *');
  });
});
