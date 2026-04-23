import express from 'express';
import { all, get, run } from '../db.js';
import { searchProjects, searchTeam, searchBusinessLines, searchNotes } from '../../search.js';
import { getUserEmail } from '../auth.js';

const router = express.Router();

interface CalendarEvent {
  type: 'project' | 'timeoff' | 'holiday'
  name: string
  color: string
  projectName?: string
  person?: string
  startDate?: string
  endDate?: string
}

interface CalendarDay {
  day: number
  date: string
  dayName: string
  events: CalendarEvent[]
}

interface CalendarMonth {
  name: string
  year: number
  month: number
  days: CalendarDay[]
}

// ============ COMBINED DATA ============

router.get('/data', async (req, res) => {
  try {
    const projects = await all('SELECT * FROM projects ORDER BY createdAt DESC').then((p: any[]) => p.map((proj: any) => ({
      ...proj,
      timeline: proj.timeline ? JSON.parse(proj.timeline) : [],
      customLinks: proj.customLinks ? JSON.parse(proj.customLinks) : [],
      designers: proj.designers ? JSON.parse(proj.designers) : [],
      businessLines: proj.businessLine ? (() => { try { return JSON.parse(proj.businessLine); } catch { return [proj.businessLine]; } })() : []
    })));
    const team = await all('SELECT * FROM team ORDER BY name').then((m: any[]) => m.map((t: any) => ({
      ...t,
      brands: JSON.parse(t.brands || '[]'),
      timeOff: t.timeOff ? JSON.parse(t.timeOff) : []
    })));
    const brands = await all('SELECT name FROM business_lines ORDER BY name').then((b: any[]) => b.map((x: any) => x.name));
    res.json({ projects, team, brandOptions: brands });
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

// ============ SEARCH ============

router.get('/search', async (req, res) => {
  try {
    const query = (req.query.q as string || '').trim();
    const scopes = {
      projects: req.query.projects !== 'false',
      team: req.query.team !== 'false',
      businessLines: req.query.businessLines !== 'false',
      notes: req.query.notes !== 'false'
    };

    if (!query || query.length < 2) {
      return res.json({ projects: [], team: [], businessLines: [], notes: [] });
    }

    const [projectResults, teamResults, blResults, noteResults] = await Promise.all([
      scopes.projects ? searchProjects(query, all) : Promise.resolve([]),
      scopes.team ? searchTeam(query, all) : Promise.resolve([]),
      scopes.businessLines ? searchBusinessLines(query, all) : Promise.resolve([]),
      scopes.notes ? searchNotes(query, all) : Promise.resolve([])
    ]);

    res.json({
      projects: projectResults.map((r: any) => r.item),
      team: teamResults.map((r: any) => r.item),
      businessLines: blResults.map((r: any) => r.item),
      notes: noteResults.map((r: any) => r.item)
    });
  } catch (e: any) {
    console.error('Search error:', e);
    res.status(500).json({error: e.message});
  }
});

// ============ CALENDAR DATA ============

router.get('/calendar', async (req, res) => {
  try {
    const projects = await all('SELECT * FROM projects').then((p: any[]) => p.map((proj: any) => ({
      ...proj,
      timeline: proj.timeline ? JSON.parse(proj.timeline) : [],
      businessLines: proj.businessLine ? (() => { try { return JSON.parse(proj.businessLine); } catch { return [proj.businessLine]; } })() : []
    })));
    const team = await all('SELECT * FROM team').then((m: any[]) => m.map((t: any) => ({
      ...t,
      timeOff: t.timeOff ? JSON.parse(t.timeOff) : []
    })));
    const holidays = await all('SELECT * FROM holidays ORDER BY date') as { id: string; name: string; date: string }[];

    const now = new Date();
    const calYear = now.getFullYear();
    const maxDate = new Date(calYear, 11, 31, 12, 0, 0, 0);

    const months: CalendarMonth[] = [];
    const current = new Date(calYear, 0, 1);
    while (current <= maxDate) {
      const monthName = current.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const daysInMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();

      const days: CalendarDay[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayOfWeek = new Date(current.getFullYear(), current.getMonth(), d).getDay();
        const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek];

        const events: CalendarEvent[] = [];

        projects.forEach((proj: any) => {
          if (proj.startDate && proj.endDate && dateStr >= proj.startDate && dateStr <= proj.endDate) {
            events.push({
              type: 'project', name: proj.name, projectName: proj.name,
              startDate: proj.startDate, endDate: proj.endDate, color: '#6366f1'
            });
          }
        });

        team.forEach((member: any) => {
          if (member.timeOff) {
            member.timeOff.forEach((off: { name: string; startDate: string; endDate: string }) => {
              if (off.startDate && off.endDate && dateStr >= off.startDate && dateStr <= off.endDate) {
                events.push({
                  type: 'timeoff', name: off.name || 'Time Off', person: member.name,
                  startDate: off.startDate, endDate: off.endDate, color: '#ef4444'
                });
              }
            });
          }
        });

        const matchingHolidays = holidays.filter(h => h.date === dateStr);
        matchingHolidays.forEach(h => {
          events.unshift({
            type: 'holiday', name: h.name, color: '#6b7280',
            startDate: h.date, endDate: h.date
          });
        });

        days.push({ day: d, date: dateStr, dayName, events });
      }

      months.push({ name: monthName, year: current.getFullYear(), month: current.getMonth() + 1, days });
      current.setMonth(current.getMonth() + 1);
    }

    const minDate = new Date(calYear, 0, 1, 12, 0, 0, 0);
    res.json({ months, startDate: minDate.toISOString().split('T')[0], endDate: maxDate.toISOString().split('T')[0] });
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

// ============ ACTIVITY LOG ============

router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500)
    const email = getUserEmail(req)
    // Scope rule: comment activity is personal — only show it to the author or a
    // declared recipient. All other categories stay global. This keeps the bell
    // from surfacing every comment to every logged-in user.
    const user = email
      ? await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
      : null
    const userId = user?.id ?? null

    if (!userId) {
      const rows = await all(
        `SELECT * FROM activity_log
         WHERE NOT (category = 'review' AND action = 'comment')
         ORDER BY created_at DESC LIMIT ?`,
        [limit]
      )
      return res.json(rows)
    }

    const rows = await all(
      `SELECT * FROM activity_log WHERE id IN (
         SELECT id FROM activity_log
         WHERE NOT (category = 'review' AND action = 'comment')
         UNION
         SELECT al.id FROM activity_log al
         WHERE al.category = 'review' AND al.action = 'comment'
           AND (LOWER(al.user_email) = LOWER(?) OR EXISTS (
             SELECT 1 FROM activity_recipients ar WHERE ar.activity_id = al.id AND ar.user_id = ?
           ))
       )
       ORDER BY created_at DESC LIMIT ?`,
      [email, userId, limit]
    )
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Week-scoped comment-activity rollup for the projects-page risk widget.
// scope=global → every review comment this week (total count + detail rows)
// scope=mine   → unread comments this week where the current user is a recipient
router.get('/activity/comment-week', async (req, res) => {
  try {
    const scope = req.query.scope === 'mine' ? 'mine' : 'global'
    const email = getUserEmail(req)
    // ISO-week-ish window: Monday 00:00 UTC through now, to match the app's
    // other "this week" calculations. SQLite: weekday 0=Sunday ... 6=Saturday.
    // Use strftime('%w','now') to find days since Sunday, subtract 1 then mod 7
    // to get days since Monday. Clamp to UTC.
    const weekStartSql = `datetime(datetime('now','start of day','-' || ((CAST(strftime('%w','now') AS INTEGER)+6) % 7) || ' days'))`

    if (scope === 'mine') {
      if (!email) return res.json({ count: 0, items: [] })
      const user = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
      if (!user?.id) return res.json({ count: 0, items: [] })
      const rows = await all(
        `SELECT al.id, al.target_name, al.user_email, al.details, al.created_at
         FROM activity_log al
         JOIN activity_recipients ar ON ar.activity_id = al.id AND ar.user_id = ?
         LEFT JOIN activity_reads arr ON arr.activity_id = al.id AND arr.user_id = ?
         WHERE al.category = 'review' AND al.action = 'comment'
           AND al.created_at >= ${weekStartSql}
           AND arr.activity_id IS NULL
         ORDER BY al.created_at DESC`,
        [user.id, user.id]
      )
      return res.json({ count: (rows as any[]).length, items: rows })
    }

    // Global: every comment posted this week, no read-state filter
    const rows = await all(
      `SELECT al.id, al.target_name, al.user_email, al.details, al.created_at
       FROM activity_log al
       WHERE al.category = 'review' AND al.action = 'comment'
         AND al.created_at >= ${weekStartSql}
       ORDER BY al.created_at DESC`
    )
    res.json({ count: (rows as any[]).length, items: rows })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router;
