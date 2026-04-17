export function markdownToHtml(text: string): string {
  if (!text) return ''
  return text.split('\n').map(line => {
    const bulletMatch = line.match(/^(\s*)- (.*)/)
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2)
      let content = bulletMatch[2]
      content = escapeHtml(content)
      content = convertLinksToHtml(content)
      content = convertBoldToHtml(content)
      return `<div class="rte-bullet" data-indent="${Math.min(indent, 3)}">${content || '<br>'}</div>`
    }
    let html = escapeHtml(line)
    html = convertLinksToHtml(html)
    html = convertBoldToHtml(html)
    return `<div>${html || '<br>'}</div>`
  }).join('')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function convertLinksToHtml(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="weekly-inline-link">$1</a>'
  )
}

function convertBoldToHtml(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

export function markdownToClipboardHtml(text: string): string {
  if (!text) return ''
  const lines = text.split('\n')
  let html = ''
  let inList = false
  let listStack: number[] = []

  const closeListsTo = (targetDepth: number) => {
    while (listStack.length > targetDepth) {
      html += '</li></ul>'
      listStack.pop()
    }
  }

  const renderInline = (line: string): string => {
    let s = escapeHtml(line)
    s = convertLinksToHtml(s)
    s = convertBoldToHtml(s)
    return s
  }

  for (const line of lines) {
    const bulletMatch = line.match(/^(\s*)- (.*)/)
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2)
      const content = renderInline(bulletMatch[2])

      if (!inList) {
        html += '<ul><li>' + content
        listStack.push(0)
        inList = true
      } else if (indent > listStack[listStack.length - 1]) {
        html += '<ul><li>' + content
        listStack.push(indent)
      } else if (indent < listStack[listStack.length - 1]) {
        closeListsTo(listStack.findIndex(d => d >= indent) + 1 || 1)
        html += '</li><li>' + content
      } else {
        html += '</li><li>' + content
      }
    } else {
      if (inList) {
        closeListsTo(0)
        inList = false
      }
      if (line.trim()) {
        html += '<p>' + renderInline(line) + '</p>'
      } else {
        html += '<br>'
      }
    }
  }

  if (inList) closeListsTo(0)
  return html
}

export function copyRichText(markdown: string, plainText?: string): Promise<void> {
  const html = markdownToClipboardHtml(markdown)
  const plain = plainText ?? markdown
  const blob = new Blob([html], { type: 'text/html' })
  const textBlob = new Blob([plain], { type: 'text/plain' })
  return navigator.clipboard.write([
    new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob })
  ])
}

export function htmlToMarkdown(el: HTMLElement): string {
  let result = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement
      const tag = elem.tagName
      if (tag === 'STRONG' || tag === 'B') {
        const inner = htmlToMarkdown(elem)
        if (inner.trim()) result += `**${inner}**`
      } else if (tag === 'A') {
        result += `[${elem.textContent || ''}](${elem.getAttribute('href') || ''})`
      } else if (tag === 'BR') {
        result += '\n'
      } else if (tag === 'DIV' || tag === 'P') {
        if (result && !result.endsWith('\n')) result += '\n'
        if (elem.classList.contains('rte-bullet')) {
          const indent = parseInt(elem.dataset.indent || '0', 10)
          const prefix = '  '.repeat(indent) + '- '
          result += prefix + htmlToMarkdown(elem)
        } else {
          result += htmlToMarkdown(elem)
        }
      } else {
        result += htmlToMarkdown(elem)
      }
    }
  }
  return result
}
