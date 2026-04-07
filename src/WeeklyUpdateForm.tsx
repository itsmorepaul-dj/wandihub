import React, { useState, useEffect, useRef, useCallback } from 'react'
import { TrendingUp, TrendingDown, Megaphone, UserCheck, List, Link as LinkIcon, ChevronDown, ChevronRight } from 'lucide-react'
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
  highlight: 'What went well this week? Include metrics if applicable.\nUse \u2022 for bullet points, [text](url) for links.',
  lowlight: 'What challenges or blockers came up?\nUse \u2022 for bullet points, [text](url) for links.',
  fyi: 'Upcoming deadlines, launches, reviews.\nOne item per line or use \u2022 for bullets.',
  people: 'OOO, new hires, role changes, team updates.\nOne item per line or use \u2022 for bullets.',
}

type TabKey = 'highlight' | 'lowlight' | 'fyi' | 'people'

function renderPreview(text: string, placeholder: string, onClickEdit: () => void) {
  if (!text.trim()) {
    return (
      <div className="weekly-desc-preview" onClick={onClickEdit}>
        <span className="weekly-preview-placeholder">{placeholder.split('\n')[0]}</span>
      </div>
    )
  }
  return (
    <div className="weekly-desc-preview" onClick={onClickEdit}>
      {text.split('\n').map((line, li) => {
        const parts: React.ReactNode[] = []
        let last = 0
        const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
        let m: RegExpExecArray | null
        while ((m = linkRe.exec(line)) !== null) {
          if (m.index > last) parts.push(line.slice(last, m.index))
          parts.push(
            <a key={`${li}-${m.index}`} href={m[2]} target="_blank" rel="noopener noreferrer" className="weekly-inline-link"
              onClick={e => e.stopPropagation()}>{m[1]}</a>
          )
          last = m.index + m[0].length
        }
        if (last < line.length) parts.push(line.slice(last))
        return <div key={li} className="weekly-preview-line">{parts.length > 0 ? parts : '\u00A0'}</div>
      })}
    </div>
  )
}

export default function WeeklyUpdateForm({
  project, projectUpdates, weeklyGeneral, designerId,
  isExpanded, onToggle, onSave, onAddProjectLink,
}: WeeklyUpdateFormProps) {
  const existingHighlight = projectUpdates.find(u => u.type === 'highlight') || null
  const existingLowlight = projectUpdates.find(u => u.type === 'lowlight') || null
  const hasUpdate = !!(existingHighlight || existingLowlight)

  const [draft, setDraft] = useState({ highlight: '', lowlight: '', risk_reason: '', resolution: '', fyi: '', people: '' })
  const [activeTab, setActiveTab] = useState<TabKey>('highlight')
  const [editing, setEditing] = useState(false)
  const [linkPopover, setLinkPopover] = useState(false)
  const [linkDraft, setLinkDraft] = useState({ name: '', url: '' })
  const linkAnchorRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Load draft from existing data when expanding
  useEffect(() => {
    if (isExpanded) {
      const fyis = weeklyGeneral.filter(e => e.category === 'fyi' && e.designer_id === designerId)
      const people = weeklyGeneral.filter(e => e.category === 'people' && e.designer_id === designerId)
      setDraft({
        highlight: existingHighlight?.description || '',
        lowlight: existingLowlight?.description || '',
        risk_reason: existingLowlight?.risk_reason || '',
        resolution: existingLowlight?.resolution || '',
        fyi: fyis.map(e => e.content).join('\n'),
        people: people.map(e => e.content).join('\n'),
      })
      setActiveTab('highlight')
      setEditing(false)
    }
  }, [isExpanded])

  // Close link popover on outside click
  useEffect(() => {
    if (!linkPopover) return
    const handler = (e: MouseEvent) => {
      if (linkAnchorRef.current && !linkAnchorRef.current.contains(e.target as Node)) setLinkPopover(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [linkPopover])

  const handleCollapse = useCallback(async () => {
    await onSave({ ...draft, existingHighlight, existingLowlight })
  }, [draft, existingHighlight, existingLowlight, onSave])

  const projectLinks = [
    project.deckLink && { name: project.deckName || 'Deck', url: project.deckLink },
    project.prdLink && { name: project.prdName || 'PRD', url: project.prdLink },
    project.briefLink && { name: project.briefName || 'Brief', url: project.briefLink },
    project.figmaLink && { name: 'Figma', url: project.figmaLink },
    ...(project.customLinks || []),
  ].filter(Boolean) as { name: string; url: string }[]

  const insertBullet = () => {
    const val = draft[activeTab]
    const insert = val.length === 0 || val.endsWith('\n') ? '\u2022 ' : '\n\u2022 '
    setDraft(d => ({ ...d, [activeTab]: val + insert }))
    setEditing(true)
    requestAnimationFrame(() => {
      if (taRef.current) { taRef.current.focus(); taRef.current.setSelectionRange(taRef.current.value.length, taRef.current.value.length) }
    })
  }

  const insertLinkText = (name: string, url: string) => {
    const val = draft[activeTab]
    const insert = `[${name}](${url})`
    setDraft(d => ({ ...d, [activeTab]: val + insert }))
  }

  const handleLinkAdd = () => {
    const name = linkDraft.name.trim()
    const url = linkDraft.url.trim()
    if (!name || !url) return
    const val = draft[activeTab]
    const insert = `[${name}](${url})`
    setDraft(d => ({ ...d, [activeTab]: val + insert }))
    onAddProjectLink(name, url)
    setLinkPopover(false)
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
        onClick={isExpanded ? handleCollapse : onToggle}
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
                className={`weekly-tab weekly-tab-${tab.key}${activeTab === tab.key ? ' active' : ''}${draft[tab.key].trim() ? ' filled' : ''}`}
                onClick={() => { setActiveTab(tab.key); setEditing(false) }}
              >
                <span className="weekly-tab-icon">{tab.icon}</span>
                <span className="weekly-tab-label">{tab.label}</span>
                {draft[tab.key].trim() && <span className="weekly-tab-dot" />}
              </button>
            ))}
          </div>
          <div className="weekly-tab-body">
            <div className="weekly-toolbar">
              <button className="weekly-toolbar-btn" title="Insert bullet" onClick={insertBullet}>
                <List size={13} />
              </button>
              <div className="weekly-link-anchor" ref={linkAnchorRef}>
                <button className="weekly-toolbar-btn" title="Add link" onClick={() => {
                  if (linkPopover) { setLinkPopover(false) } else { setLinkDraft({ name: '', url: '' }); setLinkPopover(true) }
                }}>
                  <LinkIcon size={13} />
                </button>
                {linkPopover && (
                  <div className="weekly-link-popover">
                    <input type="text" className="weekly-link-input" placeholder="Link name" value={linkDraft.name}
                      onChange={e => setLinkDraft(d => ({ ...d, name: e.target.value }))} autoFocus
                      onKeyDown={e => { if (e.key === 'Escape') setLinkPopover(false) }} />
                    <input type="url" className="weekly-link-input" placeholder="https://..." value={linkDraft.url}
                      onChange={e => setLinkDraft(d => ({ ...d, url: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Escape') setLinkPopover(false); if (e.key === 'Enter') handleLinkAdd() }} />
                    <div className="weekly-link-popover-hint">Enter to add</div>
                  </div>
                )}
              </div>
              {projectLinks.length > 0 && (
                <div className="weekly-auto-links">
                  {projectLinks.map((link, i) => (
                    <button key={i} className="weekly-auto-link" title={`Insert [${link.name}](${link.url})`}
                      onClick={() => insertLinkText(link.name, link.url)}>
                      <LinkIcon size={10} /> {link.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {editing ? (
              <textarea
                ref={taRef}
                className="weekly-desc-input"
                placeholder={PLACEHOLDERS[activeTab]}
                value={draft[activeTab]}
                onChange={e => setDraft(d => ({ ...d, [activeTab]: e.target.value }))}
                rows={5}
                autoFocus
                onBlur={() => setEditing(false)}
              />
            ) : (
              renderPreview(draft[activeTab], PLACEHOLDERS[activeTab], () => setEditing(true))
            )}
            {activeTab === 'lowlight' && draft.lowlight.trim() && (
              <div className="weekly-lowlight-extras">
                <div className="weekly-field">
                  <label className="weekly-field-label weekly-field-risk">If at risk, why?</label>
                  <textarea className="weekly-desc-input weekly-desc-input-sm" placeholder="Describe the risk"
                    value={draft.risk_reason} onChange={e => setDraft(d => ({ ...d, risk_reason: e.target.value }))} rows={2} />
                </div>
                <div className="weekly-field">
                  <label className="weekly-field-label weekly-field-resolution">Path to resolution</label>
                  <textarea className="weekly-desc-input weekly-desc-input-sm" placeholder="What needs to happen to resolve this?"
                    value={draft.resolution} onChange={e => setDraft(d => ({ ...d, resolution: e.target.value }))} rows={2} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
