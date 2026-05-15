// Executive Summary engine. Reuses the weekly snapshot data shape (highlights,
// lowlights, fyis, peopleUpdates, projectFyis, projectPeople) and produces a
// terse "exec voice" rewrite of each prose entry.
//
// Determinism by design: the structure (BL grouping, project links, designer
// chips, section headings) is computed in code, NEVER asked of the model.
// The model only rewrites prose fields under hard length and tone rules.

import crypto from 'crypto'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'

// Bedrock model ID for Sonnet 4.6 via cross-region inference. The Bedrock SDK
// reads AWS_BEARER_TOKEN_BEDROCK + AWS_REGION from env automatically.
export const EXEC_SUMMARY_MODEL = 'global.anthropic.claude-sonnet-4-6'

export interface ExecRuleset {
  voice: string                    // tone/voice rules, e.g. "executive, declarative, no jargon"
  maxWordsPerBite: number          // hard cap per soundbite
  includeRiskLine: boolean         // for lowlights, include "Risk: ..." line
  includeResolutionLine: boolean   // for lowlights, include "Path: ..." line
  excludePatterns: string          // free-form: things never to surface (PII, internal refs, etc.)
  customNotes: string              // any per-run extra guidance (free-form)
}

// Locked baseline. Any drift from this is shown to the admin in the modal.
// Editing this constant is the only way the "default" voice changes.
export const BASELINE_RULESET: ExecRuleset = {
  voice: [
    'Executive voice: declarative, present tense, third person.',
    'No filler ("we", "our team", "currently working on"). Lead with the outcome or status.',
    'No hedging ("might", "should", "hopefully"). State what is true.',
    'No jargon, no acronyms unless universally known.',
    'Each soundbite is one sentence. No semicolons. No em-dashes.',
    'Preserve explicit links.',
  ].join(' '),
  maxWordsPerBite: 22,
  includeRiskLine: true,
  includeResolutionLine: true,
  excludePatterns: [
    'Internal-only ticket numbers, branch names, code identifiers.',
    'Speculation about other teams.',
    'Personnel performance commentary.',
  ].join(' '),
  customNotes: '',
}

// Stable hash for cache keying. Sorts keys so two semantically equal rulesets
// always produce the same hash regardless of property order.
export const hashRuleset = (rs: ExecRuleset): string => {
  const canonical = JSON.stringify(rs, Object.keys(rs).sort())
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// Categorized prose item. The structural fields (project name, designers, BL)
// are passed through untouched; only `description` is rewritten by the model.
interface ProseItem {
  id: string                       // stable id from the snapshot row
  category: 'highlight' | 'lowlight' | 'fyi' | 'people' | 'general-highlight' | 'general-lowlight'
  business_line: string
  project_id: string | null
  project_name: string | null
  designers: string[]              // list of designer names
  description: string              // raw author text — to be rewritten
  risk_reason?: string             // lowlights only
  resolution?: string              // lowlights only
}

// Output rewritten item. `bite` is the model-trimmed sentence.
export interface RewrittenItem extends ProseItem {
  bite: string
  risk_bite?: string
  resolution_bite?: string
}

// Snapshot data_json shape (subset of generateSnapshotPayload's output).
interface SnapshotData {
  week?: string
  highlights?: any[]
  lowlights?: any[]
  generalHighlights?: any[]
  generalLowlights?: any[]
  fyis?: any[]
  peopleUpdates?: any[]
  projectFyis?: any[]
  projectPeople?: any[]
}

// Flatten a snapshot's data_json into a single list of ProseItems for the model.
// Matches generateSnapshotPayload's enrichment in server/routes/weekly.ts.
export const flattenSnapshot = (data: SnapshotData): ProseItem[] => {
  const out: ProseItem[] = []
  const designersFor = (row: any): string[] => {
    if (Array.isArray(row.designers)) return row.designers.filter(Boolean)
    if (row.designer_name) return [row.designer_name]
    return []
  }
  for (const u of data.highlights || []) {
    out.push({
      id: `h:${u.id}`,
      category: 'highlight',
      business_line: u.primary_business_line || 'General',
      project_id: u.project_id || null,
      project_name: u.project_name || null,
      designers: designersFor(u),
      description: u.description || '',
    })
  }
  for (const u of data.lowlights || []) {
    out.push({
      id: `l:${u.id}`,
      category: 'lowlight',
      business_line: u.primary_business_line || 'General',
      project_id: u.project_id || null,
      project_name: u.project_name || null,
      designers: designersFor(u),
      description: u.description || '',
      risk_reason: u.risk_reason || undefined,
      resolution: u.resolution || undefined,
    })
  }
  for (const e of data.generalHighlights || []) {
    out.push({
      id: `gh:${e.id}`, category: 'general-highlight', business_line: 'General',
      project_id: null, project_name: null,
      designers: designersFor(e), description: e.content || '',
    })
  }
  for (const e of data.generalLowlights || []) {
    out.push({
      id: `gl:${e.id}`, category: 'general-lowlight', business_line: 'General',
      project_id: null, project_name: null,
      designers: designersFor(e), description: e.content || '',
      risk_reason: e.risk_reason || undefined,
      resolution: e.resolution || undefined,
    })
  }
  for (const e of data.fyis || []) {
    out.push({
      id: `f:${e.id}`, category: 'fyi', business_line: 'General',
      project_id: null, project_name: null,
      designers: designersFor(e), description: e.content || '',
    })
  }
  for (const e of data.projectFyis || []) {
    out.push({
      id: `pf:${e.id}`, category: 'fyi',
      business_line: e.primary_business_line || 'General',
      project_id: e.project_id || null,
      project_name: e.project_name || null,
      designers: designersFor(e), description: e.content || '',
    })
  }
  for (const e of data.peopleUpdates || []) {
    out.push({
      id: `pp:${e.id}`, category: 'people', business_line: 'General',
      project_id: null, project_name: null,
      designers: designersFor(e), description: e.content || '',
    })
  }
  for (const e of data.projectPeople || []) {
    out.push({
      id: `ppp:${e.id}`, category: 'people',
      business_line: e.primary_business_line || 'General',
      project_id: e.project_id || null,
      project_name: e.project_name || null,
      designers: designersFor(e), description: e.content || '',
    })
  }
  // Drop empty descriptions — Claude has nothing to rewrite.
  return out.filter(item => item.description.trim().length > 0)
}

// Build the system prompt. Static across calls within a request, so the SDK
// will treat it as a cache-friendly prefix.
const buildSystemPrompt = (rs: ExecRuleset): string => `You are an executive editor for a weekly design status report. You rewrite raw author notes into terse executive soundbites.

Rules — these are absolute:
- ${rs.voice}
- Each rewrite is at most ${rs.maxWordsPerBite} words.
- Output one bite per item. No intros, no summaries, no headers.
- Never invent facts. If the input has no concrete claim, return the input compressed, do not embellish.
- Never include: ${rs.excludePatterns}
- Preserve any markdown links from the input verbatim (format: [label](https://url)). Keep bare URLs as plain http(s) text — never strip, paraphrase, or shorten URLs. Links count toward the word cap but cannot be removed to make room.
- Never invent links or URLs that were not in the input.
${rs.customNotes ? `- Additional run-specific notes: ${rs.customNotes}` : ''}

You will receive a JSON array of items. For each item, return the rewritten "bite". For items with risk_reason or resolution fields, also rewrite those (each capped at ${rs.maxWordsPerBite} words).

Output ONLY a JSON array, in the same order as input, where each element is:
{"id": "<echo the input id>", "bite": "<rewritten description>", "risk_bite": "<rewritten risk_reason or omit>", "resolution_bite": "<rewritten resolution or omit>"}`

// Single-call rewrite: send all items, get all bites back. One round trip per
// generation. If item count is huge we could batch, but typical weekly volume
// (~30-60 items) is well within Sonnet's context. Credentials are sourced
// from the standard AWS env chain by the SDK (AWS_BEARER_TOKEN_BEDROCK is the
// expected mechanism in this deployment).
export const rewriteAll = async (
  items: ProseItem[],
  ruleset: ExecRuleset,
): Promise<RewrittenItem[]> => {
  if (items.length === 0) return []
  const client = new AnthropicBedrock()
  const userPayload = items.map(it => ({
    id: it.id,
    category: it.category,
    description: it.description,
    ...(it.risk_reason ? { risk_reason: it.risk_reason } : {}),
    ...(it.resolution ? { resolution: it.resolution } : {}),
  }))
  const msg = await client.messages.create({
    model: EXEC_SUMMARY_MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(ruleset),
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  })
  const textBlock = msg.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text content')
  }
  const raw = textBlock.text.trim()
  // Strip code-fence wrappers if the model added any.
  const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
  let parsed: Array<{ id: string; bite: string; risk_bite?: string; resolution_bite?: string }>
  try {
    parsed = JSON.parse(cleaned)
  } catch (e: any) {
    throw new Error(`Claude returned invalid JSON: ${e.message}\n\n${raw.slice(0, 500)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('Claude response was not a JSON array')
  // Map back to items by id; preserve original order.
  const byId = new Map(parsed.map(r => [r.id, r]))
  return items.map(it => {
    const r = byId.get(it.id)
    return {
      ...it,
      bite: normalizeLinks(r?.bite || it.description),
      ...(it.risk_reason && r?.risk_bite ? { risk_bite: normalizeLinks(r.risk_bite) } : {}),
      ...(it.resolution && r?.resolution_bite ? { resolution_bite: normalizeLinks(r.resolution_bite) } : {}),
    }
  })
}

// Promote bare-domain links inside `[label](url)` to `https://`. Authors and
// the model both produce `[foo](google.com)` regularly — the in-app
// renderer's link regex requires `https?://`, so without this fix those URLs
// render as raw text. Idempotent on already-prefixed URLs.
const normalizeLinks = (text: string): string => {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const trimmed = url.trim()
    if (/^https?:\/\//i.test(trimmed)) return match
    if (/^mailto:|^tel:|^#/i.test(trimmed)) return match
    // Looks like a domain (has a dot, no spaces) — prepend https://
    if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed)) {
      return `[${label}](https://${trimmed})`
    }
    return match
  })
}

// Final structured output: BL groups, project clusters within each, sections
// within each project. Assembled deterministically from the rewritten items.
export interface ExecSummaryProject {
  project_id: string | null
  project_name: string | null
  designers: string[]
  highlights: { id: string; bite: string }[]
  lowlights: { id: string; bite: string; risk?: string; resolution?: string }[]
  fyis: { id: string; bite: string }[]
  people: { id: string; bite: string }[]
}

export interface ExecSummaryBLGroup {
  business_line: string
  general: ExecSummaryProject     // project-less items for this BL go here
  projects: ExecSummaryProject[]
}

export interface ExecSummaryOutput {
  week: string
  generated_at: string
  model: string
  business_lines: ExecSummaryBLGroup[]
}

export const assembleOutput = (
  week: string,
  items: RewrittenItem[],
  generatedAt: string,
): ExecSummaryOutput => {
  const blMap = new Map<string, Map<string, ExecSummaryProject>>()
  const generalMap = new Map<string, ExecSummaryProject>()
  const ensureBL = (bl: string) => {
    if (!blMap.has(bl)) blMap.set(bl, new Map())
    if (!generalMap.has(bl)) {
      generalMap.set(bl, {
        project_id: null, project_name: null, designers: [],
        highlights: [], lowlights: [], fyis: [], people: [],
      })
    }
  }
  const ensureProject = (bl: string, item: RewrittenItem): ExecSummaryProject => {
    ensureBL(bl)
    const projects = blMap.get(bl)!
    if (!item.project_id) return generalMap.get(bl)!
    if (!projects.has(item.project_id)) {
      projects.set(item.project_id, {
        project_id: item.project_id,
        project_name: item.project_name,
        designers: [...item.designers],
        highlights: [], lowlights: [], fyis: [], people: [],
      })
    }
    const p = projects.get(item.project_id)!
    // Merge designer lists (some categories list a single designer, others a project list).
    for (const d of item.designers) if (!p.designers.includes(d)) p.designers.push(d)
    return p
  }
  for (const it of items) {
    const target = ensureProject(it.business_line, it)
    if (it.category === 'highlight' || it.category === 'general-highlight') {
      target.highlights.push({ id: it.id, bite: it.bite })
    } else if (it.category === 'lowlight' || it.category === 'general-lowlight') {
      target.lowlights.push({
        id: it.id,
        bite: it.bite,
        ...(it.risk_bite ? { risk: it.risk_bite } : {}),
        ...(it.resolution_bite ? { resolution: it.resolution_bite } : {}),
      })
    } else if (it.category === 'fyi') {
      target.fyis.push({ id: it.id, bite: it.bite })
    } else if (it.category === 'people') {
      target.people.push({ id: it.id, bite: it.bite })
    }
  }
  const business_lines: ExecSummaryBLGroup[] = []
  // "General" sorts first so renderers that iterate `business_lines` in order
  // (e.g. the Docs paste output) put project-less general notes at the top.
  // The in-app modal renderer lifts the General bucket separately, so it
  // already shows first there — this keeps both surfaces in sync.
  const allBLs = Array.from(new Set([...blMap.keys(), ...generalMap.keys()])).sort((a, b) => {
    if (a === 'General' && b !== 'General') return -1
    if (b === 'General' && a !== 'General') return 1
    return a.localeCompare(b)
  })
  for (const bl of allBLs) {
    const general = generalMap.get(bl)!
    const projects = Array.from((blMap.get(bl) || new Map()).values())
      .sort((a, b) => (a.project_name || '').localeCompare(b.project_name || ''))
    const generalHasContent = general.highlights.length || general.lowlights.length || general.fyis.length || general.people.length
    if (!generalHasContent && projects.length === 0) continue
    business_lines.push({ business_line: bl, general, projects })
  }
  return {
    week,
    generated_at: generatedAt,
    model: EXEC_SUMMARY_MODEL,
    business_lines,
  }
}
