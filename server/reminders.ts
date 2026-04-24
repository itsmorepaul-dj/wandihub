// Scheduled reminders that fan out personalized activity rows.
//
// Three reminders today:
//   1. weekly-update  — Friday 10am ET, per-designer if they haven't filed
//   2. holiday-lookahead — daily, any holiday in the next 7 days
//   3. pto-self — daily, each team member's own upcoming PTO within 3 days
//
// Dedupe strategy: each reminder writes a uniquely-keyed `details` string
// (including a date token and the target's id) so we can detect "already
// sent" by grepping activity_log. No new table needed.

import { all, get, run } from './db.js';
import { logActivity } from './version.js';
import { pinRecipients, userIdForEmail } from './activity.js';

function isoWeekStr(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYmd(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
}

// Check whether an activity row with the given `details` LIKE pattern already
// exists — used as a dedupe sentinel per reminder cycle.
async function alreadySent(category: string, action: string, targetPrefix: string, sentinelPattern: string): Promise<boolean> {
  const row = await get(
    `SELECT id FROM activity_log
     WHERE category = ? AND action = ? AND target_name LIKE ? AND details LIKE ?
     LIMIT 1`,
    [category, action, `${targetPrefix}%`, sentinelPattern]
  ) as any;
  return !!row?.id;
}

// ============ 1. Weekly update reminder ============
// Fires once per (week, designer). A designer is reminded if:
//   • not excluded
//   • has an email we can resolve to a user
//   • has no weekly_updates OR weekly_general row for the current ISO week
//   • is not on PTO today

async function runWeeklyUpdateReminder() {
  const now = new Date();
  const week = isoWeekStr(now);
  const today = ymd(now);

  const designers = await all(
    `SELECT id, name, email, timeOff FROM team
     WHERE (excluded IS NULL OR excluded = 0) AND email IS NOT NULL AND email != ''`
  ) as any[];

  for (const d of designers) {
    const uid = await userIdForEmail(d.email);
    if (!uid) continue;

    // Skip if on PTO today
    let timeOff: any[] = [];
    try { timeOff = d.timeOff ? JSON.parse(d.timeOff) : []; } catch { timeOff = []; }
    const onPto = timeOff.some(t => {
      const start = t.startDate;
      const end = t.endDate;
      return start && end && today >= start && today <= end;
    });
    if (onPto) continue;

    // Has the designer filed this week?
    const filed = await get(
      `SELECT id FROM weekly_updates WHERE designer_id = ? AND week = ? LIMIT 1`,
      [d.id, week]
    ) as any;
    if (filed?.id) continue;
    const filedGeneral = await get(
      `SELECT id FROM weekly_general WHERE designer_id = ? AND week = ? LIMIT 1`,
      [d.id, week]
    ) as any;
    if (filedGeneral?.id) continue;

    // Dedupe: already sent this week?
    const sentinel = `%"reminder":"weekly-update","week":"${week}","designer_id":"${d.id}"%`;
    if (await alreadySent('project', 'update', 'Weekly update reminder', sentinel)) continue;

    const details = JSON.stringify({
      reminder: 'weekly-update',
      week,
      designer_id: d.id,
      summary: `You haven't filed your weekly update for ${week}.`,
    });
    const activityId = await logActivity('project', 'update', 'Weekly update reminder', null, details);
    await pinRecipients(activityId, [uid]);
  }
}

// ============ 2. Holiday / special-day lookahead ============
// For each holiday in the next 7 days, write one activity row fanning out
// to every active designer (dedupe per holiday+user so daily cron doesn't
// re-fire).

async function runHolidayLookahead() {
  const now = new Date();
  const todayStr = ymd(now);
  const weekOutStr = ymd(new Date(now.getTime() + 7 * 86400_000));

  const holidays = await all(
    `SELECT id, name, date FROM holidays WHERE date >= ? AND date <= ? ORDER BY date`,
    [todayStr, weekOutStr]
  ) as any[];

  if (holidays.length === 0) return;

  const designers = await all(
    `SELECT email FROM team
     WHERE (excluded IS NULL OR excluded = 0) AND email IS NOT NULL AND email != ''`
  ) as { email: string }[];

  for (const h of holidays) {
    // Dedupe per holiday (not per-user): one activity row per holiday's
    // lookahead window. The fan-out recipients cover all designers.
    const sentinel = `%"reminder":"holiday-lookahead","holiday_id":"${h.id}"%`;
    if (await alreadySent('holiday', 'update', 'Upcoming:', sentinel)) continue;

    const daysOut = Math.max(0, Math.round((parseYmd(h.date)!.getTime() - now.getTime()) / 86400_000));
    const when = daysOut === 0 ? 'today' : daysOut === 1 ? 'tomorrow' : `in ${daysOut} days`;
    const details = JSON.stringify({
      reminder: 'holiday-lookahead',
      holiday_id: h.id,
      holiday_name: h.name,
      holiday_date: h.date,
      summary: `${h.name} is ${when} (${h.date}).`,
    });
    const activityId = await logActivity('holiday', 'update', `Upcoming: ${h.name}`, null, details);
    const uids: number[] = [];
    for (const t of designers) {
      const uid = await userIdForEmail(t.email);
      if (uid) uids.push(uid);
    }
    await pinRecipients(activityId, uids);
  }
}

// ============ 3. PTO-to-self reminder ============
// Each team member gets reminded 3 days before each of their own PTO entries
// starts. Dedupe per (timeOff.id + user).

async function runPtoSelfReminder() {
  const now = new Date();
  const threeDaysOut = ymd(new Date(now.getTime() + 3 * 86400_000));
  const todayStr = ymd(now);

  const members = await all(
    `SELECT id, name, email, timeOff FROM team
     WHERE (excluded IS NULL OR excluded = 0) AND email IS NOT NULL AND email != ''`
  ) as any[];

  for (const m of members) {
    let timeOff: any[] = [];
    try { timeOff = m.timeOff ? JSON.parse(m.timeOff) : []; } catch { timeOff = []; }
    if (timeOff.length === 0) continue;
    const uid = await userIdForEmail(m.email);
    if (!uid) continue;

    for (const to of timeOff) {
      if (!to.startDate || !to.id) continue;
      // Fire when today <= start <= 3-days-out (and start not already passed).
      if (to.startDate < todayStr || to.startDate > threeDaysOut) continue;

      const sentinel = `%"reminder":"pto-self","timeoff_id":"${to.id}"%`;
      if (await alreadySent('holiday', 'update', 'PTO reminder:', sentinel)) continue;

      const daysOut = Math.max(0, Math.round((parseYmd(to.startDate)!.getTime() - now.getTime()) / 86400_000));
      const when = daysOut === 0 ? 'today' : daysOut === 1 ? 'tomorrow' : `in ${daysOut} days`;
      const details = JSON.stringify({
        reminder: 'pto-self',
        timeoff_id: to.id,
        start_date: to.startDate,
        end_date: to.endDate,
        summary: `Your PTO (${to.name || 'time off'}) starts ${when} on ${to.startDate}.`,
      });
      const activityId = await logActivity('holiday', 'update', `PTO reminder: ${to.name || 'Time off'}`, null, details);
      await pinRecipients(activityId, [uid]);
    }
  }
}

// ============ Scheduler ============
// Tick every 30 seconds. Fire weekly-update reminder on Fri 10:00 ET. Fire
// holiday & PTO reminders daily at 9:00 ET. Each runner internally dedupes.

let lastWeeklyKey = '';
let lastDailyKey = '';

export function startReminderCron() {
  setInterval(() => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    const hour = et.getHours();
    const minute = et.getMinutes();
    const dayKey = `${et.getFullYear()}-${et.getMonth()}-${et.getDate()}`;

    // Friday 10:00 ET — weekly-update reminder
    if (day === 5 && hour === 10 && minute === 0 && lastWeeklyKey !== dayKey) {
      lastWeeklyKey = dayKey;
      runWeeklyUpdateReminder().catch(e => console.error('weekly-update reminder failed:', e));
    }

    // Daily 09:00 ET — holiday lookahead + PTO-self
    if (hour === 9 && minute === 0 && lastDailyKey !== dayKey) {
      lastDailyKey = dayKey;
      runHolidayLookahead().catch(e => console.error('holiday lookahead failed:', e));
      runPtoSelfReminder().catch(e => console.error('pto-self reminder failed:', e));
    }
  }, 30_000);
  console.log('Reminder cron started (weekly Fri 10am ET; holidays + PTO daily 9am ET)');
}
