import React, { useState, useEffect, useRef } from 'react'
import { TrendingUp, TrendingDown, Megaphone, UserCheck, ChevronDown, ChevronRight } from 'lucide-react'
import RichTextEditor, { type RichTextEditorHandle } from './components/RichTextEditor'
import type { Project, WeeklyUpdate, WeeklyGeneral } from './types'

interface WeeklyUpdateFormProps {
  project: Project
  projectUpdates: WeeklyUpdate[]
  weeklyGeneral: WeeklyGeneral[]
  designerId: string
  isExpanded: boolean
  onToggle: () => void
  onSave: (data: {
    highlight: string; lowlight: string; risk_reason: string; resolution: string; fyi: string; people: string
    existingHighlight: WeeklyUpdate | null; existingLowlight: WeeklyUpdate | null
  }) => Promise<void>
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

  const [draft, setDraft] = useState({ highlight: '', lowlight: '', risk_reason: '', resolution: '', fyi: '', people: '' })
  const [activeTab, setActiveTab] = useState<TabKey>('highlight')
  const editorRef = useRef<RichTextEditorHandle>(null)
  const draftRef = useRef(draft)
  const activeTabRef = useRef(activeTab)
  draftRef.current = draft
  activeTabRef.current = activeTab

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
      setActiveTab('highlight')
      activeTabRef.current = 'highlight'
    }
  }, [isExpanded])

  useEffect(() => {
    if (!isExpanded) return
    return () => {
      onSave({ ...draftRef.current, existingHighlight, existingLowlight })
    }
  }, [isExpanded])

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
        </div>
      )}
    </div>
  )
}
