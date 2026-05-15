// Admin-only Executive Summary endpoint. Wraps Claude (Sonnet 4.6) around the
// same data_json shape used by /weekly-snapshots/preview, with deterministic
// structure assembled in code. Gated behind EXEC_SUMMARY_ENABLED so the
// feature can ship dark and flip on at the new host post-migration.

import express from 'express'
import crypto from 'crypto'
import { run, get } from '../db.js'
import { requireAdmin, getUserEmail } from '../auth.js'
import {
  BASELINE_RULESET,
  EXEC_SUMMARY_MODEL,
  ExecRuleset,
  flattenSnapshot,
  hashRuleset,
  rewriteAll,
  assembleOutput,
} from '../execSummary.js'
import { generateSnapshotPayload, getActiveWeek } from './weekly.js'

const router = express.Router()

// Feature flag — both Bedrock credentials and the explicit flag must be set
// for the endpoint to function. Otherwise it 503s so the client can show a
// "not configured" state instead of a generic error. Credentials come from
// the AWS env chain: AWS_BEARER_TOKEN_BEDROCK (preferred), or
// AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or an AWS_PROFILE.
const isEnabled = (): { ok: boolean; reason?: string } => {
  if (process.env.EXEC_SUMMARY_ENABLED !== 'true' && process.env.EXEC_SUMMARY_ENABLED !== '1') {
    return { ok: false, reason: 'EXEC_SUMMARY_ENABLED is not set' }
  }
  const hasBedrockToken = !!process.env.AWS_BEARER_TOKEN_BEDROCK
  const hasIamCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  const hasProfile = !!process.env.AWS_PROFILE
  if (!hasBedrockToken && !hasIamCreds && !hasProfile) {
    return { ok: false, reason: 'No Bedrock credentials (AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID/SECRET or AWS_PROFILE)' }
  }
  if (!process.env.AWS_REGION) {
    return { ok: false, reason: 'AWS_REGION is not set' }
  }
  return { ok: true }
}

// Validate + coerce client-supplied ruleset. Anything missing falls back to baseline.
const sanitizeRuleset = (raw: any): ExecRuleset => {
  const r = raw || {}
  return {
    voice: typeof r.voice === 'string' && r.voice.trim() ? r.voice.trim() : BASELINE_RULESET.voice,
    maxWordsPerBite: Number.isFinite(r.maxWordsPerBite) && r.maxWordsPerBite > 0 && r.maxWordsPerBite <= 80
      ? Math.floor(r.maxWordsPerBite)
      : BASELINE_RULESET.maxWordsPerBite,
    includeRiskLine: typeof r.includeRiskLine === 'boolean' ? r.includeRiskLine : BASELINE_RULESET.includeRiskLine,
    includeResolutionLine: typeof r.includeResolutionLine === 'boolean' ? r.includeResolutionLine : BASELINE_RULESET.includeResolutionLine,
    excludePatterns: typeof r.excludePatterns === 'string' ? r.excludePatterns : BASELINE_RULESET.excludePatterns,
    customNotes: typeof r.customNotes === 'string' ? r.customNotes : '',
  }
}

// Status — lets the client decide whether to show the button at all.
router.get('/exec-summary/status', requireAdmin, (_req, res) => {
  const e = isEnabled()
  res.json({ enabled: e.ok, reason: e.reason || null, model: EXEC_SUMMARY_MODEL })
})

// Baseline ruleset — shipped to the client so it can show a reset button + drift indicator.
router.get('/exec-summary/baseline', requireAdmin, (_req, res) => {
  res.json({ ruleset: BASELINE_RULESET })
})

// Last-used ruleset (any week). Pre-fills the generation modal so admins iterate
// from where they left off, while the diff badge against baseline keeps drift visible.
router.get('/exec-summary/last-ruleset', requireAdmin, async (_req, res) => {
  try {
    const row = await get(
      `SELECT ruleset_json FROM exec_summaries ORDER BY generated_at DESC LIMIT 1`
    ) as { ruleset_json?: string } | undefined
    if (!row?.ruleset_json) return res.json({ ruleset: null })
    const parsed = JSON.parse(row.ruleset_json)
    res.json({ ruleset: sanitizeRuleset(parsed) })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Generate (or return cached). force=true bypasses the cache.
router.post('/exec-summary', requireAdmin, async (req, res) => {
  const e = isEnabled()
  if (!e.ok) return res.status(503).json({ error: 'Executive summary not configured', reason: e.reason })
  try {
    const body = req.body || {}
    const week = (body.week as string) || getActiveWeek()
    const ruleset = sanitizeRuleset(body.ruleset)
    const force = body.force === true
    const ruleset_hash = hashRuleset(ruleset)

    // Pull the same payload the /preview endpoint produces. Live data unless the
    // client passes a frozen snapshot week; we don't differentiate here because
    // the upstream snapshot table also stores frozen data_json — both flow through
    // the same payload shape.
    const payload = await generateSnapshotPayload(week)
    const data_hash = crypto.createHash('sha256').update(payload.dataJson).digest('hex').slice(0, 16)

    if (!force) {
      const cached = await get(
        `SELECT output_json, generated_at, model FROM exec_summaries
         WHERE snapshot_week = ? AND ruleset_hash = ? AND data_hash = ?`,
        [week, ruleset_hash, data_hash]
      ) as { output_json: string; generated_at: string; model: string } | undefined
      if (cached) {
        return res.json({
          cached: true,
          week,
          ruleset_hash,
          data_hash,
          model: cached.model,
          generated_at: cached.generated_at,
          output: JSON.parse(cached.output_json),
        })
      }
    }

    const items = flattenSnapshot(payload.data)
    const rewritten = await rewriteAll(items, ruleset)
    const generatedAt = new Date().toISOString()
    const output = assembleOutput(week, rewritten, generatedAt)

    const id = `${week}-${ruleset_hash}-${data_hash}`
    await run(
      `INSERT OR REPLACE INTO exec_summaries
       (id, snapshot_week, ruleset_hash, data_hash, ruleset_json, output_json, model, generated_at, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, week, ruleset_hash, data_hash, JSON.stringify(ruleset), JSON.stringify(output), EXEC_SUMMARY_MODEL, generatedAt, getUserEmail(req) || '']
    )
    res.json({ cached: false, week, ruleset_hash, data_hash, model: EXEC_SUMMARY_MODEL, generated_at: generatedAt, output })
  } catch (err: any) {
    console.error('exec-summary error:', err)
    res.status(500).json({ error: err.message || 'Generation failed' })
  }
})

export default router
