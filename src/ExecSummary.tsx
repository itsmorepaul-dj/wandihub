// Executive Summary feature: rules-editor modal + report view component.
// Admin-only. Wraps the existing weekly snapshot data and runs each prose entry
// through Claude (Sonnet 4.6) under tunable rules to produce terse exec bites.
//
// Structure (BL grouping, project order, designers, links) is deterministic —
// computed in code on the server and rendered as-is here. The model only
// rewrites the prose fields.

import React, { useMemo, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, Sparkles, AlertCircle, User } from 'lucide-react'
import type { Project } from './types'
import type { ExecSummary, ExecBite, ExecProject } from './utils/execSummaryDocsHtml'

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
  /** Called with the chosen ruleset; promise resolves when generation finishes. */
  onGenerate: (ruleset: ExecRuleset, force: boolean) => Promise<void>
  generating: boolean
  error: string | null
}

// Rough deep-equal tuned to ExecRuleset shape.
const rulesetsEqual = (a: ExecRuleset | null, b: ExecRuleset | null): boolean => {
  if (!a || !b) return a === b
  return a.voice === b.voice
    && a.maxWordsPerBite === b.maxWordsPerBite
    && a.includeRiskLine === b.includeRiskLine
    && a.includeResolutionLine === b.includeResolutionLine
    && a.excludePatterns === b.excludePatterns
    && a.customNotes === b.customNotes
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
  onClose, baseline, initialRuleset, onGenerate, generating, error,
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
        <div className="modal-actions" style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)' }}>
          <button className="secondary-btn" onClick={onClose} disabled={generating}>Cancel</button>
          <button className="primary-btn" onClick={() => onGenerate(current, false)} disabled={generating || !voice.trim()}>
            {generating ? 'Generating…' : 'Generate'}
          </button>
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

interface ReportViewProps {
  summary: ExecSummary
  currentProjects: Project[]
  cached: boolean
  /** Force-regenerate and replace the in-modal output. */
  onRegenerate: () => Promise<void>
  regenerating: boolean
}

const projectAppUrl = (project_id: string | null): string | null => {
  if (!project_id) return null
  return `${window.location.origin}/?project=${encodeURIComponent(project_id)}`
}

const Bites = ({ label, color, items }: { label: string; color: string; items: ExecBite[] }) => {
  if (items.length === 0) return null
  return (
    <div style={{ marginTop: '0.5em' }}>
      <div style={{
        fontSize: '0.65rem', fontWeight: 700, color, textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: '0.25em',
      }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: '1.25em', color: 'var(--color-text)' }}>
        {items.map(b => (
          <li key={b.id} style={{ marginBottom: '0.2em', lineHeight: 1.45, fontSize: '0.875rem' }}>
            {b.bite}
            {b.risk && (
              <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: '0.15em' }}>
                <strong>Risk:</strong> {b.risk}
              </div>
            )}
            {b.resolution && (
              <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: '0.15em' }}>
                <strong>Path:</strong> {b.resolution}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

const ProjectBlock = ({ gp, currentProjects }: { gp: ExecProject; currentProjects: Project[] }) => {
  const url = projectAppUrl(gp.project_id)
  const proj = gp.project_id ? currentProjects.find(p => p.id === gp.project_id) : null
  const links = proj ? [
    proj.deckLink && { name: proj.deckName || 'Deck', url: proj.deckLink },
    proj.prdLink && { name: proj.prdName || 'PRD', url: proj.prdLink },
    proj.briefLink && { name: proj.briefName || 'Brief', url: proj.briefLink },
    proj.figmaLink && { name: 'Figma', url: proj.figmaLink },
    ...(proj.customLinks || []),
  ].filter(Boolean) as { name: string; url: string }[] : []
  return (
    <div style={{ marginTop: '1em', paddingTop: '0.75em', borderTop: '1px solid var(--color-border-subtle)' }}>
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-text)' }}>
        {url ? (
          <a href={url} style={{ color: 'var(--color-text-link)', textDecoration: 'none' }}>{gp.project_name || 'General'}</a>
        ) : (gp.project_name || 'General')}
      </div>
      {gp.designers.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5em', marginTop: '0.25em' }}>
          {gp.designers.map(d => (
            <span key={d} style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.3em',
              fontSize: '0.7rem', color: 'var(--color-text-muted)',
            }}>
              <User size={10} /> {d.split(' ')[0]}
            </span>
          ))}
        </div>
      )}
      {links.length > 0 && (
        <div style={{ marginTop: '0.25em', fontSize: '0.78rem' }}>
          {links.map((l, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: 'var(--color-text-dim)', margin: '0 0.4em' }}>·</span>}
              <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-text-link)' }}>{l.name}</a>
            </React.Fragment>
          ))}
        </div>
      )}
      <Bites label="Highlight" color="#137333" items={gp.highlights} />
      <Bites label="Lowlight" color="#c5221f" items={gp.lowlights} />
      <Bites label="FYI" color="#b06000" items={gp.fyis} />
      <Bites label="People" color="#6a1b9a" items={gp.people} />
    </div>
  )
}

export function ExecSummaryReportView({ summary, currentProjects, cached, onRegenerate, regenerating }: ReportViewProps) {
  const generatedDate = useMemo(() => new Date(summary.generated_at).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }), [summary.generated_at])
  return (
    <div style={{ padding: '0 0.25em' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '0.5em',
        marginBottom: '1em', paddingBottom: '0.6em',
        borderBottom: '1px solid var(--color-border)',
      }}>
        <div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
            {generatedDate} · {summary.model}
            {cached && <span style={{ marginLeft: '0.5em', color: 'var(--color-text-dim)' }}>(cached)</span>}
          </div>
        </div>
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          className="secondary-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em' }}
        >
          <RefreshCw size={12} style={regenerating ? { animation: 'spin 1s linear infinite' } : {}} />
          {regenerating ? 'Regenerating…' : 'Regenerate'}
        </button>
      </div>
      {summary.business_lines.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', textAlign: 'center', padding: '2em' }}>
          No content for this week yet.
        </div>
      )}
      {summary.business_lines.map(bl => {
        const generalHasContent = bl.general.highlights.length || bl.general.lowlights.length || bl.general.fyis.length || bl.general.people.length
        return (
          <div key={bl.business_line} style={{ marginBottom: '1.5em' }}>
            <h3 style={{
              fontSize: '1rem', fontWeight: 700, margin: '1em 0 0.4em',
              paddingBottom: '0.25em', borderBottom: '2px solid var(--color-border)',
              letterSpacing: '-0.01em',
            }}>{bl.business_line}</h3>
            {generalHasContent ? <ProjectBlock gp={bl.general} currentProjects={currentProjects} /> : null}
            {bl.projects.map(gp => (
              <ProjectBlock key={gp.project_id || 'general'} gp={gp} currentProjects={currentProjects} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
