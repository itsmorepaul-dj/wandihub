import React, { useState, useEffect, useRef } from 'react'
import { TrendingUp, TrendingDown, Megaphone, UserCheck, Loader2, Trash2 } from 'lucide-react'
import RichTextEditor from './components/RichTextEditor'
import type { WeeklyGeneral } from './types'

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

export interface WeeklyGeneralFormProps {
  weeklyGeneral: WeeklyGeneral[]
  designerId: string
  week: string
  /** Controls whether the form editor is mounted/visible. The parent owns
   *  the accordion header so this form integrates with the existing
   *  "Optional General Notes" disclosure on the Reports tab. */
  isExpanded: boolean
  onSave: (category: TabKey, content: string, existingId?: string) => Promise<void>
  onDelete: (category: TabKey) => Promise<void>
}

type Draft = Record<TabKey, string>
const EMPTY_DRAFT: Draft = { highlight: '', lowlight: '', fyi: '', people: '' }

export default function WeeklyGeneralForm({
  weeklyGeneral, designerId, isExpanded, onSave, onDelete,
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

  const isDirty = (): boolean => {
    const b = baselineRef.current
    const d = draftRef.current
    return d.highlight !== b.highlight || d.lowlight !== b.lowlight || d.fyi !== b.fyi || d.people !== b.people
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

  const activeExisting = entriesRef.current[activeTab]

  if (!isExpanded) return null

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
          </div>
          <div className="weekly-inline-footer">
            <span className={`weekly-save-status weekly-save-status-${saveState}${isDirty() && saveState === 'idle' ? ' dirty' : ''}`}>
              {saveState === 'saving' && (<><Loader2 size={11} className="weekly-save-spin" /> Saving…</>)}
              {saveState === 'error' && (<>Save failed — try again</>)}
              {saveState === 'idle' && isDirty() && (<>Unsaved changes</>)}
              {saveState === 'idle' && !isDirty() && <>&nbsp;</>}
            </span>
            {activeExisting && (
              <button
                type="button"
                className="weekly-delete-btn"
                onClick={() => onDelete(activeTab)}
                title={`Delete this week's ${activeTab}`}
              >
                <Trash2 size={11} /> Delete
              </button>
            )}
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
