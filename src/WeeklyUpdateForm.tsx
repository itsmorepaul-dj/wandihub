import React, { useState, useEffect, useRef } from 'react'
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
  highlight: 'What went well this week? Include metrics if applicable.',
  lowlight: 'What challenges or blockers came up?',
  fyi: 'Upcoming deadlines, launches, reviews.',
  people: 'OOO, new hires, role changes, team updates.',
}

type TabKey = 'highlight' | 'lowlight' | 'fyi' | 'people'

function markdownToHtml(text: string): string {
  if (!text) return ''
  return text.split('\n').map(line => {
    let html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="weekly-inline-link">$1</a>'
    )
    return `<div>${html || '<br>'}</div>`
  }).join('')
}

function htmlToMarkdown(el: HTMLElement): string {
  let result = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement
      const tag = elem.tagName
      if (tag === 'A') {
        result += `[${elem.textContent || ''}](${elem.getAttribute('href') || ''})`
      } else if (tag === 'BR') {
        result += '\n'
      } else if (tag === 'DIV' || tag === 'P') {
        if (result && !result.endsWith('\n')) result += '\n'
        result += htmlToMarkdown(elem)
      } else {
        result += elem.textContent || ''
      }
    }
  }
  return result
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
  const [linkPopover, setLinkPopover] = useState(false)
  const [linkDraft, setLinkDraft] = useState({ name: '', url: '' })
  const linkAnchorRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const savedRangeRef = useRef<Range | null>(null)
  const draftRef = useRef(draft)
  const activeTabRef = useRef(activeTab)
  draftRef.current = draft
  activeTabRef.current = activeTab

  // Load draft from existing data when expanding
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
      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.innerHTML = markdownToHtml(newDraft.highlight)
        }
      })
    }
  }, [isExpanded])

  // Save on unmount (page navigation, expanding different project, etc.)
  useEffect(() => {
    if (!isExpanded) return
    return () => {
      if (editorRef.current) {
        const md = htmlToMarkdown(editorRef.current)
        draftRef.current = { ...draftRef.current, [activeTabRef.current]: md }
      }
      onSave({ ...draftRef.current, existingHighlight, existingLowlight })
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

  const projectLinks = [
    project.deckLink && { name: project.deckName || 'Deck', url: project.deckLink },
    project.prdLink && { name: project.prdName || 'PRD', url: project.prdLink },
    project.briefLink && { name: project.briefName || 'Brief', url: project.briefLink },
    project.figmaLink && { name: 'Figma', url: project.figmaLink },
    ...(project.customLinks || []),
  ].filter(Boolean) as { name: string; url: string }[]

  const syncEditor = () => {
    if (editorRef.current) {
      if (editorRef.current.innerHTML === '<br>') {
        editorRef.current.innerHTML = ''
      }
      // Wrap bare top-level text nodes in <div> so paragraph spacing applies consistently
      for (const node of Array.from(editorRef.current.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent) {
          const div = document.createElement('div')
          editorRef.current.insertBefore(div, node)
          div.appendChild(node)
        }
      }
      const md = htmlToMarkdown(editorRef.current)
      setDraft(d => ({ ...d, [activeTab]: md }))
    }
  }

  const switchTab = (tab: TabKey) => {
    if (editorRef.current) {
      const md = htmlToMarkdown(editorRef.current)
      draftRef.current = { ...draftRef.current, [activeTab]: md }
      setDraft({ ...draftRef.current })
    }
    setActiveTab(tab)
    activeTabRef.current = tab
    requestAnimationFrame(() => {
      if (editorRef.current) {
        editorRef.current.innerHTML = markdownToHtml(draftRef.current[tab])
      }
    })
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  const handleEditorClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'A') {
      if (!e.metaKey && !e.ctrlKey) {
        e.preventDefault()
      }
    }
  }

  const insertBullet = () => {
    if (!editorRef.current) return
    editorRef.current.focus()
    const isEmpty = !editorRef.current.textContent?.trim()
    if (isEmpty) {
      document.execCommand('insertHTML', false, '&#8226; ')
    } else {
      document.execCommand('insertHTML', false, '<br>&#8226; ')
    }
    syncEditor()
  }

  const saveSelection = () => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange()
    }
  }

  const restoreSelection = () => {
    const range = savedRangeRef.current
    if (range) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }

  const insertLink = (name: string, url: string) => {
    if (!editorRef.current) return
    editorRef.current.focus()
    restoreSelection()
    const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const safeUrl = url.replace(/"/g, '&quot;')
    const html = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="weekly-inline-link">${safeName}</a>`
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      document.execCommand('insertHTML', false, html)
    } else {
      editorRef.current.innerHTML += html
    }
    syncEditor()
  }

  const openLinkPopover = () => {
    saveSelection()
    const sel = window.getSelection()
    const selectedText = (sel && editorRef.current?.contains(sel.anchorNode)) ? (sel.toString() || '') : ''
    setLinkDraft({ name: selectedText, url: '' })
    setLinkPopover(true)
    if (selectedText) {
      requestAnimationFrame(() => urlInputRef.current?.focus())
    }
  }

  const handleLinkAdd = () => {
    const name = linkDraft.name.trim()
    const url = linkDraft.url.trim()
    if (!name || !url) return
    insertLink(name, url)
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
            <div className="weekly-toolbar">
              <button className="weekly-toolbar-btn" title="Insert bullet" onMouseDown={e => e.preventDefault()} onClick={insertBullet}>
                <List size={13} />
              </button>
              <div className="weekly-link-anchor" ref={linkAnchorRef}>
                <button className="weekly-toolbar-btn" title="Add link" onMouseDown={e => e.preventDefault()} onClick={() => {
                  if (linkPopover) { setLinkPopover(false) } else { openLinkPopover() }
                }}>
                  <LinkIcon size={13} />
                </button>
                {linkPopover && (
                  <div className="weekly-link-popover">
                    <input type="text" className="weekly-link-input" placeholder="Link name" value={linkDraft.name}
                      onChange={e => setLinkDraft(d => ({ ...d, name: e.target.value }))} autoFocus={!linkDraft.name}
                      onKeyDown={e => { if (e.key === 'Escape') setLinkPopover(false); if (e.key === 'Enter') { e.preventDefault(); urlInputRef.current?.focus() } }} />
                    <input ref={urlInputRef} type="url" className="weekly-link-input" placeholder="https://..." value={linkDraft.url}
                      onChange={e => setLinkDraft(d => ({ ...d, url: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Escape') setLinkPopover(false); if (e.key === 'Enter') handleLinkAdd() }} />
                    <button className="weekly-link-add-btn" onClick={handleLinkAdd}
                      disabled={!linkDraft.name.trim() || !linkDraft.url.trim()}>Add link</button>
                  </div>
                )}
              </div>
              {projectLinks.length > 0 && (
                <div className="weekly-auto-links">
                  {projectLinks.map((link, i) => (
                    <button key={i} className="weekly-auto-link" title={`Insert [${link.name}](${link.url})`}
                      onMouseDown={e => e.preventDefault()} onClick={() => insertLink(link.name, link.url)}>
                      <LinkIcon size={10} /> {link.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div
              ref={editorRef}
              className="weekly-desc-input weekly-editor"
              contentEditable
              suppressContentEditableWarning
              onInput={syncEditor}
              onPaste={handlePaste}
              onClick={handleEditorClick}
              onMouseUp={saveSelection}
              onKeyUp={saveSelection}
              data-placeholder={PLACEHOLDERS[activeTab]}
            />
            <div className="weekly-resize-handle" onMouseDown={(e) => {
              e.preventDefault()
              const editor = editorRef.current
              if (!editor) return
              const startY = e.clientY
              const startH = editor.offsetHeight
              const onMove = (ev: MouseEvent) => { editor.style.height = Math.max(80, startH + ev.clientY - startY) + 'px' }
              const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }} />
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
