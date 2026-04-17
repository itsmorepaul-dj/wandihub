import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Bold, List, Link as LinkIcon, IndentIncrease, IndentDecrease } from 'lucide-react'
import { markdownToHtml, htmlToMarkdown } from '../utils/richtext'

export interface RichTextEditorHandle {
  focus: () => void
  getMarkdown: () => string
}

interface RichTextEditorProps {
  value: string
  onChange: (markdown: string) => void
  onBlur?: () => void
  placeholder?: string
  features?: Array<'bold' | 'bullets' | 'links'>
  quickLinks?: Array<{ name: string; url: string }>
  onLinkInserted?: (name: string, url: string) => void
  className?: string
  minHeight?: string
  resizable?: boolean
}

const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(({
  value,
  onChange,
  onBlur,
  placeholder = '',
  features = ['bold', 'bullets', 'links'],
  quickLinks,
  onLinkInserted,
  className = '',
  minHeight = '80px',
  resizable = false,
}, ref) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string>(value)
  const savedRangeRef = useRef<Range | null>(null)
  const linkAnchorRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  const [linkPopover, setLinkPopover] = useState(false)
  const [linkDraft, setLinkDraft] = useState({ name: '', url: '' })
  const [isBold, setIsBold] = useState(false)

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getMarkdown: () => editorRef.current ? htmlToMarkdown(editorRef.current) : value,
  }))

  useEffect(() => {
    if (value !== lastEmittedRef.current && editorRef.current) {
      editorRef.current.innerHTML = markdownToHtml(value)
      lastEmittedRef.current = value
    }
  }, [value])

  useEffect(() => {
    if (editorRef.current && !editorRef.current.innerHTML) {
      editorRef.current.innerHTML = markdownToHtml(value)
    }
  }, [])

  useEffect(() => {
    if (!linkPopover) return
    const handler = (e: MouseEvent) => {
      if (linkAnchorRef.current && !linkAnchorRef.current.contains(e.target as Node)) {
        setLinkPopover(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [linkPopover])

  const syncEditor = useCallback(() => {
    if (!editorRef.current) return
    if (editorRef.current.innerHTML === '<br>') {
      editorRef.current.innerHTML = ''
    }
    for (const node of Array.from(editorRef.current.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent) {
        const div = document.createElement('div')
        editorRef.current.insertBefore(div, node)
        div.appendChild(node)
      }
    }
    const md = htmlToMarkdown(editorRef.current)
    lastEmittedRef.current = md
    onChange(md)
  }, [onChange])

  const updateToolbarState = useCallback(() => {
    setIsBold(document.queryCommandState('bold'))
  }, [])

  const saveSelection = useCallback(() => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange()
    }
  }, [])

  const restoreSelection = useCallback(() => {
    const range = savedRangeRef.current
    if (range) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [])

  const getCurrentLineDiv = useCallback((): HTMLElement | null => {
    const sel = window.getSelection()
    if (!sel || !sel.anchorNode || !editorRef.current) return null
    let node: Node | null = sel.anchorNode
    while (node && node !== editorRef.current) {
      if (node.parentNode === editorRef.current && node.nodeType === Node.ELEMENT_NODE) {
        return node as HTMLElement
      }
      node = node.parentNode
    }
    return null
  }, [])

  const toggleBold = useCallback(() => {
    editorRef.current?.focus()
    document.execCommand('bold')
    syncEditor()
    updateToolbarState()
  }, [syncEditor, updateToolbarState])

  const insertBullet = useCallback(() => {
    if (!editorRef.current) return
    editorRef.current.focus()
    const currentDiv = getCurrentLineDiv()
    if (currentDiv?.classList.contains('rte-bullet')) {
      document.execCommand('insertHTML', false, '<br>&#8203;')
      requestAnimationFrame(() => {
        const newDiv = getCurrentLineDiv()
        if (newDiv) {
          newDiv.classList.add('rte-bullet')
          newDiv.dataset.indent = currentDiv.dataset.indent || '0'
          newDiv.innerHTML = newDiv.innerHTML.replace('&#8203;', '').replace('\u200B', '') || '<br>'
          const range = document.createRange()
          const sel = window.getSelection()
          range.setStart(newDiv, 0)
          range.collapse(true)
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
        syncEditor()
      })
      return
    }
    const isEmpty = !editorRef.current.textContent?.trim()
    if (isEmpty) {
      editorRef.current.innerHTML = '<div class="rte-bullet" data-indent="0"><br></div>'
      const bullet = editorRef.current.querySelector('.rte-bullet')
      if (bullet) {
        const range = document.createRange()
        const sel = window.getSelection()
        range.setStart(bullet, 0)
        range.collapse(true)
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    } else {
      document.execCommand('insertHTML', false, '</div><div class="rte-bullet" data-indent="0"><br></div>')
      requestAnimationFrame(() => {
        const newBullet = editorRef.current?.querySelector('.rte-bullet:last-of-type')
        if (newBullet) {
          const range = document.createRange()
          const sel = window.getSelection()
          range.setStart(newBullet, 0)
          range.collapse(true)
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      })
    }
    syncEditor()
  }, [getCurrentLineDiv, syncEditor])

  const indentBullet = useCallback((direction: 'indent' | 'outdent') => {
    const currentDiv = getCurrentLineDiv()
    if (!currentDiv?.classList.contains('rte-bullet')) return
    const indent = parseInt(currentDiv.dataset.indent || '0', 10)
    if (direction === 'indent') {
      currentDiv.dataset.indent = String(Math.min(3, indent + 1))
    } else {
      if (indent === 0) {
        currentDiv.classList.remove('rte-bullet')
        delete currentDiv.dataset.indent
      } else {
        currentDiv.dataset.indent = String(indent - 1)
      }
    }
    syncEditor()
  }, [getCurrentLineDiv, syncEditor])

  const openLinkPopover = useCallback(() => {
    saveSelection()
    const sel = window.getSelection()
    const selectedText = (sel && editorRef.current?.contains(sel.anchorNode)) ? (sel.toString() || '') : ''
    setLinkDraft({ name: selectedText, url: '' })
    setLinkPopover(true)
    if (selectedText) {
      requestAnimationFrame(() => urlInputRef.current?.focus())
    }
  }, [saveSelection])

  const insertLink = useCallback((name: string, url: string) => {
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
  }, [restoreSelection, syncEditor])

  const handleLinkAdd = useCallback(() => {
    const name = linkDraft.name.trim()
    const url = linkDraft.url.trim()
    if (!name || !url) return
    insertLink(name, url)
    onLinkInserted?.(name, url)
    setLinkPopover(false)
  }, [linkDraft, insertLink, onLinkInserted])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }, [])

  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'A') {
      if (!e.metaKey && !e.ctrlKey) {
        e.preventDefault()
      }
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault()
      toggleBold()
      return
    }

    if (e.key === 'Tab') {
      const currentDiv = getCurrentLineDiv()
      if (currentDiv?.classList.contains('rte-bullet')) {
        e.preventDefault()
        indentBullet(e.shiftKey ? 'outdent' : 'indent')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const currentDiv = getCurrentLineDiv()
      if (currentDiv?.classList.contains('rte-bullet')) {
        e.preventDefault()
        const textContent = currentDiv.textContent?.trim()
        if (!textContent) {
          currentDiv.classList.remove('rte-bullet')
          delete currentDiv.dataset.indent
          currentDiv.innerHTML = '<br>'
          syncEditor()
          return
        }
        const indent = currentDiv.dataset.indent || '0'
        const newBullet = document.createElement('div')
        newBullet.className = 'rte-bullet'
        newBullet.dataset.indent = indent
        newBullet.innerHTML = '<br>'
        currentDiv.after(newBullet)
        const range = document.createRange()
        const sel = window.getSelection()
        range.setStart(newBullet, 0)
        range.collapse(true)
        sel?.removeAllRanges()
        sel?.addRange(range)
        syncEditor()
        return
      }
    }

    if (e.key === 'Backspace') {
      const sel = window.getSelection()
      if (sel && sel.isCollapsed) {
        const currentDiv = getCurrentLineDiv()
        if (currentDiv?.classList.contains('rte-bullet')) {
          const range = sel.getRangeAt(0)
          let atStart = false
          if (range.startOffset === 0) {
            let node: Node | null = range.startContainer
            while (node && node !== currentDiv) {
              if (node.previousSibling) break
              node = node.parentNode
            }
            if (node === currentDiv) atStart = true
          }
          if (atStart) {
            e.preventDefault()
            const indent = parseInt(currentDiv.dataset.indent || '0', 10)
            if (indent > 0) {
              currentDiv.dataset.indent = String(indent - 1)
            } else {
              currentDiv.classList.remove('rte-bullet')
              delete currentDiv.dataset.indent
            }
            syncEditor()
            return
          }
        }
      }
    }
  }, [toggleBold, getCurrentLineDiv, indentBullet, syncEditor])

  const handleInteraction = useCallback(() => {
    saveSelection()
    updateToolbarState()
  }, [saveSelection, updateToolbarState])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const editor = editorRef.current
    if (!editor) return
    const startY = e.clientY
    const startH = editor.offsetHeight
    const onMove = (ev: MouseEvent) => {
      editor.style.height = Math.max(40, startH + ev.clientY - startY) + 'px'
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const showBold = features.includes('bold')
  const showBullets = features.includes('bullets')
  const showLinks = features.includes('links')

  return (
    <div className={`rte-wrapper ${className}`}>
      <div className="rte-toolbar">
        {showBold && (
          <button
            className={`rte-toolbar-btn${isBold ? ' active' : ''}`}
            title="Bold (Cmd+B)"
            onMouseDown={e => e.preventDefault()}
            onClick={toggleBold}
          >
            <Bold size={13} />
          </button>
        )}
        {showBullets && (
          <>
            <button
              className="rte-toolbar-btn"
              title="Insert bullet"
              onMouseDown={e => e.preventDefault()}
              onClick={insertBullet}
            >
              <List size={13} />
            </button>
            <button
              className="rte-toolbar-btn"
              title="Indent (Tab)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => indentBullet('indent')}
            >
              <IndentIncrease size={13} />
            </button>
            <button
              className="rte-toolbar-btn"
              title="Outdent (Shift+Tab)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => indentBullet('outdent')}
            >
              <IndentDecrease size={13} />
            </button>
          </>
        )}
        {showLinks && (
          <div className="rte-link-anchor" ref={linkAnchorRef}>
            <button
              className="rte-toolbar-btn"
              title="Add link"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { linkPopover ? setLinkPopover(false) : openLinkPopover() }}
            >
              <LinkIcon size={13} />
            </button>
            {linkPopover && (
              <div className="rte-link-popover">
                <input
                  type="text"
                  className="rte-link-input"
                  placeholder="Link name"
                  value={linkDraft.name}
                  onChange={e => setLinkDraft(d => ({ ...d, name: e.target.value }))}
                  autoFocus={!linkDraft.name}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setLinkPopover(false)
                    if (e.key === 'Enter') { e.preventDefault(); urlInputRef.current?.focus() }
                  }}
                />
                <input
                  ref={urlInputRef}
                  type="url"
                  className="rte-link-input"
                  placeholder="https://..."
                  value={linkDraft.url}
                  onChange={e => setLinkDraft(d => ({ ...d, url: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setLinkPopover(false)
                    if (e.key === 'Enter') handleLinkAdd()
                  }}
                />
                <button
                  className="rte-link-add-btn"
                  onClick={handleLinkAdd}
                  disabled={!linkDraft.name.trim() || !linkDraft.url.trim()}
                >
                  Add link
                </button>
              </div>
            )}
          </div>
        )}
        {quickLinks && quickLinks.length > 0 && showLinks && (
          <div className="rte-quick-links">
            {quickLinks.map((link, i) => (
              <button
                key={i}
                className="rte-quick-link"
                title={`Insert [${link.name}](${link.url})`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => insertLink(link.name, link.url)}
              >
                <LinkIcon size={10} /> {link.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        ref={editorRef}
        className="rte-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={syncEditor}
        onPaste={handlePaste}
        onClick={handleEditorClick}
        onMouseUp={handleInteraction}
        onKeyUp={handleInteraction}
        onKeyDown={handleKeyDown}
        onBlur={onBlur}
        data-placeholder={placeholder}
        style={{ minHeight }}
      />
      {resizable && (
        <div className="rte-resize-handle" onMouseDown={handleResizeMouseDown} />
      )}
    </div>
  )
})

RichTextEditor.displayName = 'RichTextEditor'

export default RichTextEditor
