import React, { useState, useEffect, useRef } from 'react'
import { TrendingUp, TrendingDown, Megaphone, UserCheck, ChevronDown, ChevronRight, Check, Loader2 } from 'lucide-react'
import RichTextEditor, { type RichTextEditorHandle } from './components/RichTextEditor'
import type { Project, WeeklyUpdate, WeeklyGeneral } from './types'

export interface WeeklyUpdateSavePayload {
  highlight: string; lowlight: string; risk_reason: string; resolution: string; fyi: string; people: string
  existingHighlight: WeeklyUpdate | null; existingLowlight: WeeklyUpdate | null
}

interface WeeklyUpdateFormProps {
  project: Project
  projectUpdates: WeeklyUpdate[]
  weeklyGeneral: WeeklyGeneral[]
  designerId: string
  isExpanded: boolean
  onToggle: () => void
  onSave: (data: WeeklyUpdateSavePayload, opts?: { keepalive?: boolean }) => Promise<void>
  onAddProjectLink: (name: string, url: string) => void
}

const PLACEHOLDERS: Record<string, string> = {
  highlight: 'What went well this week? Include metrics if applicable.',
  lowlight: 'What challenges or blockers came up?',
  fyi: 'Upcoming deadlines, launches, reviews.',
  people: 'OOO, new hires, role changes, team updates.',
}

type TabKey = 'highlight' | 'lowlight' | 'fyi' | 'people'

export default function WeeklyUpdateForm({
  project, projectUpdates, weeklyGeneral, designerId,
  isExpanded, onToggle, onSave, onAddProjectLink,
}: WeeklyUpdateFormProps) {
  const existingHighlight = projectUpdates.find(u => u.type === 'highlight') || null
  const existingLowlight = projectUpdates.find(u => u.type === 'lowlight') || null
  const hasUpdate = !!(existingHighlight || existingLowlight)

  const emptyDraft = { highlight: '', lowlight: '', risk_reason: '', resolution: '', fyi: '', people: '' }
  const [draft, setDraft] = useState(emptyDraft)
  const [activeTab, setActiveTab] = useState<TabKey>('highlight')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const editorRef = useRef<RichTextEditorHandle>(null)
  const draftRef = useRef(draft)
  const activeTabRef = useRef(activeTab)
  const baselineRef = useRef(emptyDraft)
  const onSaveRef = useRef(onSave)
  const existingHighlightRef = useRef(existingHighlight)
  const existingLowlightRef = useRef(existingLowlight)
  const isExpandedRef = useRef(isExpanded)
  draftRef.current = draft
  activeTabRef.current = activeTab
  onSaveRef.current = onSave
  existingHighlightRef.current = existingHighlight
  existingLowlightRef.current = existingLowlight
  isExpandedRef.current = isExpanded

  const isDirty = (): boolean => {
    const b = baselineRef.current
    const d = draftRef.current
    return d.highlight !== b.highlight || d.lowlight !== b.lowlight || d.risk_reason !== b.risk_reason
      || d.resolution !== b.resolution || d.fyi !== b.fyi || d.people !== b.people
  }

  useEffect(() => {
    if (isExpanded) {
      const fyis = weeklyGeneral.filter(e => e.category === 'fyi' && e.designer_id === designerId)
      const people = weeklyGeneral.filter(e => e.category === 'people' && e.designer_id === designerId)
      const newDraft = {
        highlight: existingHighlight?.description || '',
        lowlight: existingLowlight?.description || '',
        risk_reason: existingLowlight?.risk_reason || '',
        resolution: existingLowlight?.resolution || '',
        fyi: fyis.map(e => e.content).join('\n'),
        people: people.map(e => e.content).join('\n'),
      }
      setDraft(newDraft)
      draftRef.current = newDraft
      baselineRef.current = newDraft
      setActiveTab('highlight')
      activeTabRef.current = 'highlight'
      setSaveState('idle')
    }
  }, [isExpanded])

  // Last-ditch flush when the form collapses: only if still dirty (user didn't click Save).
  useEffect(() => {
    if (!isExpanded) return
    return () => {
      if (isDirty()) {
        onSaveRef.current({
          ...draftRef.current,
          existingHighlight: existingHighlightRef.current,
          existingLowlight: existingLowlightRef.current,
        })
      }
    }
  }, [isExpanded])

  // Guard page close / tab hide: if dirty, flush with keepalive fetch; on beforeunload, warn.
  useEffect(() => {
    const flush = (keepalive: boolean) => {
      if (!isExpandedRef.current || !isDirty()) return false
      onSaveRef.current({
        ...draftRef.current,
        existingHighlight: existingHighlightRef.current,
        existingLowlight: existingLowlightRef.current,
      }, { keepalive })
      return true
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(true) }
    const onPageHide = () => { flush(true) }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isExpandedRef.current || !isDirty()) return
      flush(true)
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

  const saveNow = async () => {
    if (saveState === 'saving') return
    setSaveState('saving')
    try {
      await onSave({
        ...draftRef.current,
        existingHighlight: existingHighlightRef.current,
        existingLowlight: existingLowlightRef.current,
      })
      baselineRef.current = { ...draftRef.current }
      setSaveState('saved')
      window.setTimeout(() => {
        setSaveState(prev => (prev === 'saved' ? 'idle' : prev))
      }, 1800)
    } catch (e) {
      console.error('Weekly save failed:', e)
      setSaveState('error')
    }
  }

  const projectLinks = [
    project.deckLink && { name: project.deckName || 'Deck', url: project.deckLink },
    project.prdLink && { name: project.prdName || 'PRD', url: project.prdLink },
    project.briefLink && { name: project.briefName || 'Brief', url: project.briefLink },
    project.figmaLink && { name: 'Figma', url: project.figmaLink },
    ...(project.customLinks || []),
  ].filter(Boolean) as { name: string; url: string }[]

  const switchTab = (tab: TabKey) => {
    setDraft(d => ({ ...d }))
    setActiveTab(tab)
    activeTabRef.current = tab
  }

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'highlight', label: 'Highlights', icon: <TrendingUp size={12} /> },
    { key: 'lowlight', label: 'Lowlights', icon: <TrendingDown size={12} /> },
    { key: 'fyi', label: 'FYIs', icon: <Megaphone size={12} /> },
    { key: 'people', label: 'People', icon: <UserCheck size={12} /> },
  ]

  return (
    <div className="weekly-inline">
      <button
        className={`weekly-inline-toggle${hasUpdate ? ' has-update' : ''}`}
        onClick={onToggle}
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {hasUpdate ? 'Edit weekly update' : 'Weekly update'}
      </button>
      {isExpanded && (
        <div className="weekly-inline-form">
          <div className="weekly-tabs">
            {tabs.map(tab => (
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
              ref={editorRef}
              value={draft[activeTab]}
              onChange={(md) => {
                setDraft(d => ({ ...d, [activeTab]: md }))
                draftRef.current = { ...draftRef.current, [activeTab]: md }
              }}
              placeholder={PLACEHOLDERS[activeTab]}
              features={['bold', 'bullets', 'links']}
              quickLinks={projectLinks}
              onLinkInserted={onAddProjectLink}
              resizable={true}
              minHeight="88px"
            />
            {activeTab === 'lowlight' && draft.lowlight.trim() && (
              <div className="weekly-lowlight-extras">
                <div className="weekly-field">
                  <label className="weekly-field-label weekly-field-risk">If at risk, why?</label>
                  <RichTextEditor
                    value={draft.risk_reason}
                    onChange={(md) => {
                      setDraft(d => ({ ...d, risk_reason: md }))
                      draftRef.current = { ...draftRef.current, risk_reason: md }
                    }}
                    placeholder="Describe the risk"
                    features={['bold', 'bullets']}
                    minHeight="48px"
                  />
                </div>
                <div className="weekly-field">
                  <label className="weekly-field-label weekly-field-resolution">Path to resolution</label>
                  <RichTextEditor
                    value={draft.resolution}
                    onChange={(md) => {
                      setDraft(d => ({ ...d, resolution: md }))
                      draftRef.current = { ...draftRef.current, resolution: md }
                    }}
                    placeholder="What needs to happen to resolve this?"
                    features={['bold', 'bullets']}
                    minHeight="48px"
                  />
                </div>
              </div>
            )}
          </div>
          <div className="weekly-inline-footer">
            <span className={`weekly-save-status weekly-save-status-${saveState}${isDirty() && saveState !== 'saving' ? ' dirty' : ''}`}>
              {saveState === 'saving' && (<><Loader2 size={11} className="weekly-save-spin" /> Saving…</>)}
              {saveState === 'saved' && !isDirty() && (<><Check size={11} /> Saved</>)}
              {saveState === 'error' && (<>Save failed — try again</>)}
              {saveState === 'idle' && isDirty() && (<>Unsaved changes</>)}
              {saveState === 'idle' && !isDirty() && <>&nbsp;</>}
            </span>
            <button
              type="button"
              className="primary-btn weekly-save-btn"
              onClick={saveNow}
              disabled={saveState === 'saving' || !isDirty()}
            >
              {saveState === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
