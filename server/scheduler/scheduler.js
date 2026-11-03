import { nextRun } from './cron.js';

const TICK_MS = 20_000;

/**
 * Fires due schedules. Each tick looks for enabled schedules whose `nextRunAt`
 * has passed, starts a run, and advances `nextRunAt`. A schedule whose previous
 * run is still active is skipped for that slot rather than stacking runs.
 */
export class Scheduler {
  #timer = null;

  constructor({ store, engine, bus }) {
    this.store = store;
    this.engine = engine;
    this.bus = bus;
  }

  start() {
    this.resync();
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** Recompute next fire times (e.g. after a restart, so missed slots don't all fire at once). */
  resync(now = new Date()) {
    for (const s of this.store.listSchedules()) {
      const next = s.enabled ? nextRun(s.cron, now) : null;
      this.store.updateScheduleState(s.id, { nextRunAt: next?.toISOString() ?? null });
    }
  }

  tick(now = new Date()) {
    const fired = [];
    for (const s of this.store.listSchedules()) {
      if (!s.enabled || !s.nextRunAt || new Date(s.nextRunAt) > now) continue;
      const next = nextRun(s.cron, now)?.toISOString() ?? null;
      if (s.lastRunId && this.engine.activeRunIds.includes(s.lastRunId)) {
        this.store.updateScheduleState(s.id, { nextRunAt: next, lastError: 'Skipped: previous run still in progress' });
        continue;
      }
      fired.push(this.runNow(s, { nextRunAt: next }));
    }
    return fired.filter(Boolean);
  }

  runNow(schedule, { nextRunAt } = {}) {
    const patch = { lastRunAt: new Date().toISOString() };
    if (nextRunAt !== undefined) patch.nextRunAt = nextRunAt;
    try {
      const run = this.engine.startRun({
        suiteId: schedule.suiteId ?? undefined,
        testIds: schedule.testIds?.length ? schedule.testIds : undefined,
        environmentId: schedule.environmentId ?? undefined,
        name: `⏱ ${schedule.name}`,
        trigger: 'schedule',
      });
      this.store.updateScheduleState(schedule.id, { ...patch, lastRunId: run.id, lastError: null });
      this.bus.publish('schedule:updated', this.store.getSchedule(schedule.id));
      return run;
    } catch (err) {
      this.store.updateScheduleState(schedule.id, { ...patch, lastError: err.message });
      this.bus.publish('schedule:updated', this.store.getSchedule(schedule.id));
      return null;
    }
  }
}
