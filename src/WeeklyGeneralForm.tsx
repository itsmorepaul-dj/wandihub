import React, { useState, useEffect, useRef } from 'react'
import { TrendingUp, TrendingDown, Megaphone, UserCheck, Loader2, Plus } from 'lucide-react'
import RichTextEditor from './components/RichTextEditor'
import type { WeeklyGeneral, TeamMember } from './types'

type TabKey = 'highlight' | 'lowlight' | 'fyi' | 'people'

const PLACEHOLDERS: Record<TabKey, string> = {
  highlight: 'Team- or org-wide highlights that aren\'t tied to a single project.',
  lowlight: 'Team- or org-wide lowlights or blockers.',
  fyi: 'Upcoming deadlines, launches, reviews — anything the team should know.',
  people: 'OOO, new hires, role changes, team updates.',
}

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'highlight', label: 'Highlights', icon: <TrendingUp size={12} /> },
  { key: 'lowlight', label: 'Lowlights', icon: <TrendingDown size={12} /> },
  { key: 'fyi', label: 'FYIs', icon: <Megaphone size={12} /> },
  { key: 'people', label: 'People', icon: <UserCheck size={12} /> },
]

export interface LowlightExtras {
  risk_reason?: string
  resolution?: string
}

export interface WeeklyGeneralFormProps {
  weeklyGeneral: WeeklyGeneral[]
  designerId: string
  week: string
  /** Controls whether the form editor is mounted/visible. The parent owns
   *  the accordion header so this form integrates with the existing
   *  "Optional General Notes" disclosure on the Reports tab. */
  isExpanded: boolean
  /** Full team list. Used to surface upcoming OOO as one-click suggestions
   *  on the People tab so authors can decide what shows up in the report. */
  team?: TeamMember[]
  onSave: (category: TabKey, content: string, existingId?: string, extras?: LowlightExtras) => Promise<void>
  onDelete: (category: TabKey) => Promise<void>
}

// How far ahead to surface upcoming OOO as People-tab suggestions.
const OOO_LOOKAHEAD_MS = 10 * 24 * 60 * 60 * 1000

type OooSuggestion = { key: string; label: string; line: string; startMs: number }

const formatOooRange = (startISO: string, endISO: string): string => {
  const parse = (s: string) => new Date(s + (s.length === 10 ? 'T00:00:00Z' : ''))
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const s = parse(startISO)
  const e = parse(endISO || startISO)
  if (isNaN(s.getTime())) return ''
  if (isNaN(e.getTime()) || startISO === endISO) return fmt(s)
  return `${fmt(s)}–${fmt(e)}`
}

const collectOooSuggestions = (team: TeamMember[] | undefined): OooSuggestion[] => {
  if (!team || team.length === 0) return []
  const now = Date.now()
  const out: OooSuggestion[] = []
  for (const m of team) {
    for (const to of m.timeOff || []) {
      if (!to?.startDate) continue
      const start = new Date(to.startDate + (to.startDate.length === 10 ? 'T00:00:00Z' : ''))
      if (isNaN(start.getTime())) continue
      const delta = start.getTime() - now
      if (delta > OOO_LOOKAHEAD_MS) continue
      const endStr = to.endDate || to.startDate
      const end = new Date(endStr + (endStr.length === 10 ? 'T23:59:59Z' : ''))
      if (!isNaN(end.getTime()) && end.getTime() < now) continue
      const title = to.name || 'Time off'
      const range = formatOooRange(to.startDate, to.endDate || to.startDate)
      out.push({
        key: `${m.id}-${to.id || to.startDate}`,
        label: `${m.name.split(' ')[0]}: ${title}, ${range}`,
        line: `${m.name}: ${title}, ${range}`,
        startMs: start.getTime(),
      })
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

// The lowlight tab carries two extra sub-fields (risk + resolution). Other
// tabs use the same shape for uniformity and just ignore them.
type Draft = Record<TabKey, string> & {
  lowlightRisk: string
  lowlightResolution: string
}
const EMPTY_DRAFT: Draft = {
  highlight: '', lowlight: '', fyi: '', people: '',
  lowlightRisk: '', lowlightResolution: '',
}

export default function WeeklyGeneralForm({
  weeklyGeneral, designerId, isExpanded, team, onSave, onDelete,
}: WeeklyGeneralFormProps) {
  // The form edits only THIS signed-in user's general (project_id=null) rows
  // for the week. Project-scoped rows (project_id set) are owned by the
  // project card form and are deliberately invisible here.
  const myEntriesByCategory = (): Record<TabKey, WeeklyGeneral | undefined> => ({
    highlight: weeklyGeneral.find(e => e.category === 'highlight' && e.designer_id === designerId && !e.project_id),
    lowlight:  weeklyGeneral.find(e => e.category === 'lowlight'  && e.designer_id === designerId && !e.project_id),
    fyi:       weeklyGeneral.find(e => e.category === 'fyi'       && e.designer_id === designerId && !e.project_id),
    people:    weeklyGeneral.find(e => e.category === 'people'    && e.designer_id === designerId && !e.project_id),
  })

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [activeTab, setActiveTab] = useState<TabKey>('highlight')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [, forceRerender] = useState(0)

  const draftRef = useRef(draft)
  const activeTabRef = useRef(activeTab)
  const baselineRef = useRef<Draft>(EMPTY_DRAFT)
  const onSaveRef = useRef(onSave)
  const isExpandedRef = useRef(isExpanded)
  const entriesRef = useRef(myEntriesByCategory())
  draftRef.current = draft
  activeTabRef.current = activeTab
  onSaveRef.current = onSave
  isExpandedRef.current = isExpanded
  entriesRef.current = myEntriesByCategory()

  const lowlightDirty = (): boolean => {
    const b = baselineRef.current
    const d = draftRef.current
    return d.lowlight !== b.lowlight
      || d.lowlightRisk !== b.lowlightRisk
      || d.lowlightResolution !== b.lowlightResolution
  }

  const isDirty = (): boolean => {
    const b = baselineRef.current
    const d = draftRef.current
    return d.highlight !== b.highlight || lowlightDirty() || d.fyi !== b.fyi || d.people !== b.people
  }

  // Load latest content into the draft when the form is opened.
  useEffect(() => {
    if (!isExpanded) return
    const entries = entriesRef.current
    const newDraft: Draft = {
      highlight: entries.highlight?.content || '',
      lowlight: entries.lowlight?.content || '',
      fyi: entries.fyi?.content || '',
      people: entries.people?.content || '',
      lowlightRisk: entries.lowlight?.risk_reason || '',
      lowlightResolution: entries.lowlight?.resolution || '',
    }
    setDraft(newDraft)
    draftRef.current = newDraft
    baselineRef.current = newDraft
    setActiveTab('highlight')
    activeTabRef.current = 'highlight'
    setSaveState('idle')
  }, [isExpanded])

  const saveTab = async (tab: TabKey) => {
    const content = draftRef.current[tab].trim()
    const existing = entriesRef.current[tab]
    if (tab === 'lowlight') {
      // Lowlight is three fields saved as one row. Dirty check compares all
      // three against baseline; empty description still deletes the row.
      if (!lowlightDirty()) return
      const risk = draftRef.current.lowlightRisk.trim()
      const resolution = draftRef.current.lowlightResolution.trim()
      if (!content && !existing) return
      if (!content && existing) {
        await onDelete(tab)
      } else {
        await onSaveRef.current(tab, content, existing?.id, { risk_reason: risk, resolution })
      }
      baselineRef.current = {
        ...baselineRef.current,
        lowlight: content,
        lowlightRisk: risk,
        lowlightResolution: resolution,
      }
      return
    }
    if (content === (baselineRef.current[tab] || '').trim()) return
    if (!content && !existing) return
    if (!content && existing) {
      await onDelete(tab)
    } else {
      await onSaveRef.current(tab, content, existing?.id)
    }
    baselineRef.current = { ...baselineRef.current, [tab]: content }
  }

  const saveAllDirty = async () => {
    const tabs: TabKey[] = ['highlight', 'lowlight', 'fyi', 'people']
    for (const t of tabs) {
      if (t === 'lowlight') {
        if (lowlightDirty()) await saveTab(t)
        continue
      }
      if (draftRef.current[t] !== baselineRef.current[t]) {
        await saveTab(t)
      }
    }
  }

  const saveNow = async () => {
    if (saveState === 'saving') return
    setSaveState('saving')
    try {
      await saveAllDirty()
      setSaveState('idle')
    } catch (e) {
      console.error('General notes save failed:', e)
      setSaveState('error')
    }
  }

  // Tab switch: autosave the current tab if dirty so users don't lose work
  // when they hop between Highlights → FYIs mid-edit.
  const switchTab = async (tab: TabKey) => {
    const cur = activeTabRef.current
    if (draftRef.current[cur] !== baselineRef.current[cur] && saveState !== 'saving') {
      try { await saveTab(cur) } catch (e) { console.error('Tab switch save failed:', e) }
    }
    setActiveTab(tab)
    activeTabRef.current = tab
  }

  // On collapse or tab close, flush any dirty content so a user who writes
  // and navigates away doesn't silently drop their edits.
  useEffect(() => {
    if (!isExpanded) return
    return () => {
      if (isDirty()) {
        saveAllDirty().catch(err => console.error('General notes autosave on collapse failed:', err))
        baselineRef.current = { ...draftRef.current }
        forceRerender(n => n + 1)
      }
    }
  }, [isExpanded])

  useEffect(() => {
    const flush = () => {
      if (!isExpandedRef.current || !isDirty()) return
      saveAllDirty().catch(() => {})
      baselineRef.current = { ...draftRef.current }
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    const onPageHide = () => flush()
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isExpandedRef.current || !isDirty()) return
      flush()
      e.preventDefault()
      e.returnValue = ''
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  if (!isExpanded) return null

  // Surface upcoming OOO (within the lookahead window) as one-click chips on
  // the People tab. Any suggestion whose exact line is already present in the
  // draft is filtered out so the chip row shrinks as the author adds entries.
  const oooSuggestions = activeTab === 'people' ? collectOooSuggestions(team) : []
  const currentPeopleLines = new Set(
    draft.people.split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
  )
  const remainingSuggestions = oooSuggestions.filter(s => !currentPeopleLines.has(s.line))

  const addOooSuggestion = (s: OooSuggestion) => {
    const current = draftRef.current.people
    const line = `- ${s.line}`
    const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${line}` : line
    setDraft(d => ({ ...d, people: next }))
    draftRef.current = { ...draftRef.current, people: next }
  }

  return (
    <div className="weekly-inline weekly-inline-standalone">
      <div className="weekly-inline-form">
          <div className="weekly-tabs">
            {TABS.map(tab => (
              <button
                key={tab.key}
                className={`weekly-tab weekly-tab-${tab.key}${activeTab === tab.key ? ' active' : ''}`}
                onClick={() => switchTab(tab.key)}
              >
                <span className="weekly-tab-icon">{tab.icon}</span>
                <span className="weekly-tab-label">{tab.label}</span>
              </button>
            ))}
          </div>
          {activeTab === 'people' && remainingSuggestions.length > 0 && (
            <div className="weekly-ooo-suggest" role="group" aria-label="Upcoming time off">
              <span className="weekly-ooo-suggest-label">Upcoming OOO:</span>
              {remainingSuggestions.map(s => (
                <button
                  key={s.key}
                  type="button"
                  className="weekly-ooo-chip"
                  onClick={() => addOooSuggestion(s)}
                  title={`Add to People: ${s.line}`}
                >
                  <Plus size={10} />
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <div className="weekly-tab-body">
            <RichTextEditor
              key={activeTab}
              value={draft[activeTab]}
              onChange={(md) => {
                setDraft(d => ({ ...d, [activeTab]: md }))
                draftRef.current = { ...draftRef.current, [activeTab]: md }
              }}
              placeholder={PLACEHOLDERS[activeTab]}
              features={['bold', 'bullets', 'links']}
              minHeight="88px"
            />
            {activeTab === 'lowlight' && (
              <>
                <label className="weekly-sub-label">Risk</label>
                <RichTextEditor
                  key="lowlight-risk"
                  value={draft.lowlightRisk}
                  onChange={(md) => {
                    setDraft(d => ({ ...d, lowlightRisk: md }))
                    draftRef.current = { ...draftRef.current, lowlightRisk: md }
                  }}
                  placeholder="Why this is at risk (optional)"
                  features={['bold', 'bullets', 'links']}
                  minHeight="60px"
                />
                <label className="weekly-sub-label">Resolution</label>
                <RichTextEditor
                  key="lowlight-resolution"
                  value={draft.lowlightResolution}
                  onChange={(md) => {
                    setDraft(d => ({ ...d, lowlightResolution: md }))
                    draftRef.current = { ...draftRef.current, lowlightResolution: md }
                  }}
                  placeholder="Path forward (optional)"
                  features={['bold', 'bullets', 'links']}
                  minHeight="60px"
                />
              </>
            )}
          </div>
          <div className="weekly-inline-footer">
            <span className={`weekly-save-status weekly-save-status-${saveState}${isDirty() && saveState === 'idle' ? ' dirty' : ''}`}>
              {saveState === 'saving' && (<><Loader2 size={11} className="weekly-save-spin" /> Saving…</>)}
              {saveState === 'error' && (<>Save failed — try again</>)}
              {saveState === 'idle' && isDirty() && (<>Unsaved changes</>)}
              {saveState === 'idle' && !isDirty() && <>&nbsp;</>}
            </span>
            <button
              type="button"
              className={`weekly-save-btn${isDirty() ? ' is-dirty' : ''}${saveState === 'saving' ? ' is-saving' : ''}`}
              onClick={saveNow}
              disabled={saveState === 'saving'}
            >
              {saveState === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
      </div>
    </div>
  )
}
