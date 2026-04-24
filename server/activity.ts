// Activity fan-out helpers.
//
// Central place to translate "designer names on a project", "team member id",
// or "active designers" into user_ids to pin in activity_recipients. Every
// fan-out caller looks the same: compute recipients, then pinRecipients().

import { run, get, all } from './db.js';

// Returns users.id for an email, or null. Case-insensitive match.
export async function userIdForEmail(email: string | null | undefined): Promise<number | null> {
  if (!email) return null;
  const row = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any;
  return row?.id ?? null;
}

// Designer-centric: user_ids of every team member whose name appears in the
// project's designers JSON array, minus the initiator. Silent no-op for
// unmatched names.
export async function recipientsForProject(
  projectId: string,
  excludeUserId: number | null
): Promise<number[]> {
  const p = await get('SELECT designers FROM projects WHERE id = ?', [projectId]) as any;
  if (!p?.designers) return [];
  let names: string[] = [];
  try { names = JSON.parse(p.designers) || []; } catch { names = []; }
  if (names.length === 0) return [];
  const ids = new Set<number>();
  for (const n of names) {
    const t = await get('SELECT email FROM team WHERE name = ?', [n]) as any;
    const email = t?.email;
    if (!email) continue;
    const u = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any;
    if (u?.id && u.id !== excludeUserId) ids.add(u.id);
  }
  return Array.from(ids);
}

// Team-member-centric: resolve a single user_id from a team row.
export async function recipientForTeamMember(
  teamId: string,
  excludeUserId: number | null
): Promise<number[]> {
  const t = await get('SELECT email FROM team WHERE id = ?', [teamId]) as any;
  if (!t?.email) return [];
  const uid = await userIdForEmail(t.email);
  if (!uid || uid === excludeUserId) return [];
  return [uid];
}

// Every non-excluded team member's user_id. For org-wide reminders.
export async function recipientsForAllActiveDesigners(excludeUserId: number | null): Promise<number[]> {
  const teams = await all(
    `SELECT email FROM team
     WHERE (excluded IS NULL OR excluded = 0) AND email IS NOT NULL AND email != ''`
  ) as { email: string }[];
  const ids = new Set<number>();
  for (const t of teams) {
    const uid = await userIdForEmail(t.email);
    if (uid && uid !== excludeUserId) ids.add(uid);
  }
  return Array.from(ids);
}

// Write recipient rows for a given activity_id. Idempotent.
export async function pinRecipients(activityId: number | null, userIds: number[]): Promise<void> {
  if (!activityId || userIds.length === 0) return;
  for (const uid of userIds) {
    await run(
      'INSERT OR IGNORE INTO activity_recipients (activity_id, user_id) VALUES (?, ?)',
      [activityId, uid]
    );
  }
}
