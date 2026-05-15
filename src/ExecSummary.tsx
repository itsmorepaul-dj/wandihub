// Executive Summary feature: rules-editor modal + report view component.
// Admin-only. Wraps the existing weekly snapshot data and runs each prose entry
// through Claude (Sonnet 4.6) under tunable rules to produce terse exec bites.
//
// Structure (BL grouping, project order, designers, links) is deterministic —
// computed in code on the server and rendered as-is here. The model only
// rewrites the prose fields.

import { useMemo, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, Sparkles, AlertCircle } from 'lucide-react'
import type { Project } from './types'
import type { ExecSummary, ExecBite, ExecProject, ExecBLGroup } from './utils/execSummaryDocsHtml'

// ---------- Shared types ----------

export interface ExecRuleset {
  voice: string
  maxWordsPerBite: number
  includeRiskLine: boolean
  includeResolutionLine: boolean
  excludePatterns: string
  customNotes: string
}

interface RulesetEditorProps {
  open: boolean
  onClose: () => void
  /** Locked baseline shipped from the server, used for "reset" + drift indicator. */
  baseline: ExecRuleset | null
  /** Pre-fill source: last-run ruleset (server) or baseline if first run. */
  initialRuleset: ExecRuleset | null
  /** Bedrock model id (e.g. "global.anthropic.claude-sonnet-4-6") — surfaced
   * in the editor footer so the operator knows which model will run. */
  model: string | null
  /** Called with the chosen ruleset; promise resolves when generation finishes. */
  onGenerate: (ruleset: ExecRuleset, force: boolean) => Promise<void>
  generating: boolean
  error: string | null
}

// Rough deep-equal tuned to ExecRuleset shape. Free-text fields (voice,
// excludePatterns, customNotes) are normalized — trim, collapse runs of
// whitespace, drop trailing punctuation — so an extra space or period
// doesn't trip the drift indicator.
const normText = (s: string) =>
  s.replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '')
const rulesetsEqual = (a: ExecRuleset | null, b: ExecRuleset | null): boolean => {
  if (!a || !b) return a === b
  return normText(a.voice) === normText(b.voice)
    && a.maxWordsPerBite === b.maxWordsPerBite
    && a.includeRiskLine === b.includeRiskLine
    && a.includeResolutionLine === b.includeResolutionLine
    && normText(a.excludePatterns) === normText(b.excludePatterns)
    && normText(a.customNotes) === normText(b.customNotes)
}

// ---------- Rules editor modal ----------

// Outer wrapper: gates rendering on `open` and remounts the inner form each
// time the modal reopens. This sidesteps the React 19 effect-setState lint
// rule by deriving form state from props at mount, not in an effect.
export function ExecSummaryRulesModal(props: RulesetEditorProps) {
  if (!props.open) return null
  // Re-key on every open so each session gets fresh state pre-filled from the
  // current initialRuleset/baseline. `Date.now` would also work, but tying the
  // key to the incoming ruleset shape keeps it stable while the modal is open.
  const k = `${props.initialRuleset ? 'last' : 'baseline'}:${props.baseline?.maxWordsPerBite ?? '0'}`
  return <ExecSummaryRulesModalInner key={k} {...props} />
}

function ExecSummaryRulesModalInner({
  onClose, baseline, initialRuleset, model, onGenerate, generating, error,
}: RulesetEditorProps) {
  const src = initialRuleset || baseline
  const [voice, setVoice] = useState(src?.voice ?? '')
  const [maxWords, setMaxWords] = useState<number>(src?.maxWordsPerBite ?? 22)
  const [risk, setRisk] = useState(src?.includeRiskLine ?? true)
  const [resolution, setResolution] = useState(src?.includeResolutionLine ?? true)
  const [exclude, setExclude] = useState(src?.excludePatterns ?? '')
  const [notes, setNotes] = useState(src?.customNotes ?? '')
  const overlayMouseDownTarget = useRef<EventTarget | null>(null)

  const current: ExecRuleset = {
    voice,
    maxWordsPerBite: Number.isFinite(maxWords) && maxWords > 0 ? Math.floor(maxWords) : 22,
    includeRiskLine: risk,
    includeResolutionLine: resolution,
    excludePatterns: exclude,
    customNotes: notes,
  }
  const driftFromBaseline = baseline ? !rulesetsEqual(current, baseline) : false

  const resetToBaseline = () => {
    if (!baseline) return
    setVoice(baseline.voice)
    setMaxWords(baseline.maxWordsPerBite)
    setRisk(baseline.includeRiskLine)
    setResolution(baseline.includeResolutionLine)
    setExclude(baseline.excludePatterns)
    setNotes(baseline.customNotes || '')
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={e => { overlayMouseDownTarget.current = e.target }}
      onClick={e => {
        if (e.target === overlayMouseDownTarget.current && (e.target as HTMLElement).classList.contains('modal-overlay')) {
          if (!generating) onClose()
        }
      }}
    >
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h2><Sparkles size={16} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '0.4em' }} />Executive Summary — generate</h2>
          <button className="modal-close-btn" onClick={onClose} disabled={generating}>×</button>
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 1em', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            Claude rewrites each highlight, lowlight, FYI, and people note in an executive voice.
            Project names, designers, business-line groupings, and section structure are fixed and not rewritten.
          </p>

          {driftFromBaseline && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5em',
              background: 'var(--color-accent-subtle)', color: 'var(--color-accent)',
              padding: '0.5em 0.75em', borderRadius: 'var(--radius-sm)',
              fontSize: '0.78rem', marginBottom: '1em',
            }}>
              <AlertCircle size={14} />
              <span>Rules differ from baseline. Output will reflect your edits.</span>
              <button
                onClick={resetToBaseline}
                style={{
                  marginLeft: 'auto', background: 'transparent', border: 'none',
                  color: 'var(--color-accent)', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', gap: '0.3em', fontSize: '0.78rem', fontWeight: 600,
                }}
              >
                <RotateCcw size={12} /> Reset to baseline
              </button>
            </div>
          )}

          <label style={labelStyle}>Voice & tone rules</label>
          <textarea
            value={voice}
            onChange={e => setVoice(e.target.value)}
            disabled={generating}
            rows={4}
            style={textareaStyle}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1em', margin: '1em 0' }}>
            <div>
              <label style={labelStyle}>Max words per soundbite</label>
              <input
                type="number"
                min={5}
                max={80}
                value={maxWords}
                onChange={e => setMaxWords(parseInt(e.target.value, 10) || 22)}
                disabled={generating}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em', justifyContent: 'flex-end', paddingBottom: '0.4em' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.85rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={risk} onChange={e => setRisk(e.target.checked)} disabled={generating} />
                Include "Risk:" line on lowlights
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.85rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={resolution} onChange={e => setResolution(e.target.checked)} disabled={generating} />
                Include "Path:" resolution line
              </label>
            </div>
          </div>

          <label style={labelStyle}>Never surface (one rule per line)</label>
          <textarea
            value={exclude}
            onChange={e => setExclude(e.target.value)}
            disabled={generating}
            rows={3}
            style={textareaStyle}
          />

          <label style={labelStyle}>Run-specific notes <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            disabled={generating}
            rows={2}
            placeholder="e.g. emphasize Q2 milestones; deprioritize tooling notes"
            style={textareaStyle}
          />

          {error && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '0.5em',
              background: 'rgba(239,68,68,0.1)', color: 'var(--color-danger)',
              padding: '0.6em 0.75em', borderRadius: 'var(--radius-sm)',
              fontSize: '0.82rem', marginTop: '1em',
            }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="modal-actions" style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {model && (
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} title="Model used to rewrite each soundbite">
              {model}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
            <button className="secondary-btn" onClick={onClose} disabled={generating}>Cancel</button>
            <button
              className="primary-btn"
              onClick={() => onGenerate(current, false)}
              disabled={generating || !voice.trim()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em' }}
            >
              {generating && <RefreshCw size={12} style={{ animation: 'spin 0.7s linear infinite' }} />}
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- Inline styles (component-local, mapped to design tokens) ----------

const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: '0.35em',
  fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.02em',
  color: 'var(--color-text-secondary)',
}
const baseField: React.CSSProperties = {
  width: '100%', padding: '0.55em 0.75em',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const textareaStyle: React.CSSProperties = { ...baseField, resize: 'vertical', lineHeight: 1.45 }
const inputStyle: React.CSSProperties = baseField

// ---------- Output report view ----------
//
// Mirrors the structure of SnapshotReportView ("View Report") so the exec
// summary slots into the same modal with consistent design-system classes.
// What's intentionally stripped vs. View Report:
//   - Thumbnails, past reviews — visual context, irrelevant for soundbites
//   - Raw `description` body — replaced by the rewritten `bite`
//   - "Also in:" multi-BL chips — exec readers don't need cross-section nav
//   - Edit mode + per-section copy buttons — output is regenerated, not edited
//   - Project-card RTE blocks — fixed bullet list of one-line bites
// All `.rr-*` classes are inherited from App.css (the View Report styles).

interface ReportViewProps {
  summary: ExecSummary
  currentProjects: Project[]
  /** Force-regenerate and replace the in-modal output. */
  onRegenerate: () => Promise<void>
  regenerating: boolean
  /** Renders inline `[label](url)` markdown + bare URLs as anchors. Passed in
   * from App.tsx so the exec view uses the same link-rendering pipeline as
   * the View Report flow. */
  renderMarkdownLinks: (text: string) => React.ReactNode
}

const slugForBL = (name: string) => `bl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`

// Match the in-app project-filter convention used elsewhere (e.g.
// App.tsx:3860): a hash route that opens the Projects view filtered to the
// named project. Uses project_name (not id) because that's what the route
// filter reads. Falls back to null when there's no project (general items).
const projectAppUrl = (project_name: string | null): string | null => {
  if (!project_name) return null
  return `${window.location.origin}${window.location.pathname}#/projects?project=${encodeURIComponent(project_name)}`
}

// Each bite is its own paragraph — no bullets, no indent. Mirrors the View
// Report's `.rr-block-body` shape so labels (when present) sit flush-left
// above their content. Risk/Path sub-lines stay in `.rr-block-sub`.
const BiteList = ({ items, includeRiskAndPath, renderMarkdownLinks }: {
  items: ExecBite[]
  includeRiskAndPath?: boolean
  renderMarkdownLinks: (text: string) => React.ReactNode
}) => (
  <>
    {items.map(b => (
      <div key={b.id} className="rr-block-body" style={{ marginBottom: items.length > 1 ? '0.35em' : 0 }}>
        {renderMarkdownLinks(b.bite)}
        {includeRiskAndPath && b.risk && (
          <div className="rr-block-sub"><strong>Risk:</strong> {renderMarkdownLinks(b.risk)}</div>
        )}
        {includeRiskAndPath && b.resolution && (
          <div className="rr-block-sub"><strong>Path:</strong> {renderMarkdownLinks(b.resolution)}</div>
        )}
      </div>
    ))}
  </>
)

const ExecProjectCard = ({ gp, bl, renderMarkdownLinks }: {
  gp: ExecProject
  bl: string
  currentProjects: Project[]  // unused after dropping project-level link row; kept on the prop
                              // type so call sites stay forward-compatible if we re-add it later
  renderMarkdownLinks: (text: string) => React.ReactNode
}) => {
  const url = projectAppUrl(gp.project_name)
  void bl
  return (
    <div className="rr-project-card">
      {url ? (
        <a className="rr-project-name" href={url}>{gp.project_name || 'Project'}</a>
      ) : (
        <div className="rr-project-name">{gp.project_name || 'Project'}</div>
      )}
      {gp.designers.length > 0 && (
        <div className="rr-project-designers">{gp.designers.map(d => d.split(' ')[0]).join(', ')}</div>
      )}
      {gp.highlights.length > 0 && (
        <div className="rr-block rr-block-highlight">
          <BiteList items={gp.highlights} renderMarkdownLinks={renderMarkdownLinks} />
        </div>
      )}
      {gp.lowlights.length > 0 && (
        <div className="rr-block rr-block-lowlight">
          <div className="rr-block-label">Lowlight</div>
          <BiteList items={gp.lowlights} includeRiskAndPath renderMarkdownLinks={renderMarkdownLinks} />
        </div>
      )}
      {gp.fyis.length > 0 && (
        <div className="rr-block rr-block-fyi">
          <div className="rr-block-label">FYI</div>
          <BiteList items={gp.fyis} renderMarkdownLinks={renderMarkdownLinks} />
        </div>
      )}
      {gp.people.length > 0 && (
        <div className="rr-block rr-block-people">
          <div className="rr-block-label">People</div>
          <BiteList items={gp.people} renderMarkdownLinks={renderMarkdownLinks} />
        </div>
      )}
    </div>
  )
}

export function ExecSummaryReportView({ summary, currentProjects, onRegenerate, regenerating, renderMarkdownLinks }: ReportViewProps) {
  // Lift the project-less "General" BL bucket to a top-level General notes
  // section, matching SnapshotReportView's layout. Per-BL groups below it
  // contain only project-scoped content.
  const { generalSection, blSections } = useMemo(() => {
    let general: ExecBLGroup['general'] | null = null
    const bls: ExecBLGroup[] = []
    for (const bl of summary.business_lines) {
      if (bl.business_line === 'General') {
        const hasGeneral = bl.general.highlights.length || bl.general.lowlights.length || bl.general.fyis.length || bl.general.people.length
        if (hasGeneral) general = bl.general
        // Project-scoped items mistakenly tagged 'General' (no BL on the project)
        // still get their own BL section labeled "General".
        if (bl.projects.length > 0) bls.push({ ...bl, general: { project_id: null, project_name: null, designers: [], highlights: [], lowlights: [], fyis: [], people: [] } })
      } else {
        bls.push(bl)
      }
    }
    return { generalSection: general, blSections: bls }
  }, [summary.business_lines])

  const genDate = new Date(summary.generated_at)
  const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const hasAnything = generalSection !== null || blSections.length > 0

  return (
    <div className="rr rr-v2">
      <header className="rr-header">
        <div className="rr-header-main">
          <div className="rr-week">{summary.week}</div>
          <div className="rr-date">{dateStr}</div>
          {/* Cache state lives in the modal title (set by runExecSummary in App.tsx);
              no need for a duplicate chip in the report body. */}
        </div>
        <div className="rr-header-actions">
          <button
            className="rr-admin-btn"
            onClick={onRegenerate}
            disabled={regenerating}
            title="Re-run the executive summary against the current data"
          >
            <RefreshCw size={12} style={regenerating ? { animation: 'spin 1s linear infinite' } : undefined} />
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
      </header>

      {hasAnything && (
        <nav className="rr-nav" aria-label="Jump to section">
          {generalSection && <a href="#rr-general-notes">General notes</a>}
          {blSections.map(bl => (
            <a key={bl.business_line} href={`#${slugForBL(bl.business_line)}`}>{bl.business_line}</a>
          ))}
        </nav>
      )}

      {generalSection && (
        <section id="rr-general-notes" className="rr-bl-section rr-general-section">
          <h2 className="rr-bl-title" style={{ borderBottomWidth: '1px' }}>General notes</h2>
          {generalSection.highlights.length > 0 && (
            <div className="rr-subsection">
              <BiteList items={generalSection.highlights} renderMarkdownLinks={renderMarkdownLinks} />
            </div>
          )}
          {generalSection.lowlights.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-lowlight">Lowlights</h3>
              <BiteList items={generalSection.lowlights} includeRiskAndPath renderMarkdownLinks={renderMarkdownLinks} />
            </div>
          )}
          {generalSection.fyis.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-fyi">FYIs</h3>
              <BiteList items={generalSection.fyis} renderMarkdownLinks={renderMarkdownLinks} />
            </div>
          )}
          {generalSection.people.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-people">People</h3>
              <BiteList items={generalSection.people} renderMarkdownLinks={renderMarkdownLinks} />
            </div>
          )}
        </section>
      )}

      {!hasAnything && (
        <div className="rr-empty">No updates recorded for {summary.week}.</div>
      )}

      {blSections.map(bl => (
        <section key={bl.business_line} id={slugForBL(bl.business_line)} className="rr-bl-section">
          <h2 className="rr-bl-title" style={{ borderBottomWidth: '1px' }}>{bl.business_line}</h2>
          <div className="rr-project-grid">
            {bl.projects.map(gp => (
              <ExecProjectCard key={gp.project_id || 'general'} gp={gp} bl={bl.business_line} currentProjects={currentProjects} renderMarkdownLinks={renderMarkdownLinks} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
