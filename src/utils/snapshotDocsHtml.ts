import type { Project, WeeklyUpdate, WeeklyGeneral } from '../types'

// Build a clipboard-ready HTML string from a parsed snapshot data_json.
// Target: Google Docs paste. Uses inline styles because Docs strips most
// stylesheet rules but respects element-level style attributes and canonical
// tags (h1/h2/h3/ul/ol/li/strong/em/a/p/br). Avoids color on body text so
// the doc inherits the user's theme; uses color only for category labels.

interface SnapshotPayload {
  highlights?: WeeklyUpdate[]
  lowlights?: WeeklyUpdate[]
  generalHighlights?: WeeklyGeneral[]
  generalLowlights?: WeeklyGeneral[]
  fyis?: WeeklyGeneral[]
  peopleUpdates?: WeeklyGeneral[]
  projectFyis?: WeeklyGeneral[]
  projectPeople?: WeeklyGeneral[]
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Turn markdown-ish inline text (**bold**, [text](url)) into safe HTML spans.
const inlineMarkdown = (text: string): string => {
  // Escape first, then walk the raw original for tokens and rebuild.
  // Trick: run replacements on the escaped text — the tokens use only ASCII
  // and won't collide with HTML entities.
  let s = escapeHtml(text)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label, url) =>
    `<a href="${url}" style="color:#1155cc;text-decoration:underline">${label}</a>`
  )
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  return s
}

// Render a multi-line body: lines starting with "- " become <ul><li>, blank
// lines become paragraph breaks, otherwise each line is a <p>. Supports one
// level of nested bullets via leading whitespace (2 spaces = 1 indent).
const renderBody = (text: string): string => {
  if (!text || !text.trim()) return ''
  const lines = text.split('\n')
  let out = ''
  let inList = false
  let listDepth = 0
  const closeListsTo = (target: number) => {
    while (listDepth > target) { out += '</li></ul>'; listDepth-- }
  }
  const paraQueue: string[] = []
  const flushPara = () => {
    if (paraQueue.length === 0) return
    out += `<p style="margin:0 0 0.5em">${paraQueue.join('<br>')}</p>`
    paraQueue.length = 0
  }
  for (const raw of lines) {
    const bulletMatch = raw.match(/^(\s*)- (.*)$/)
    if (bulletMatch) {
      flushPara()
      const indent = Math.min(Math.floor(bulletMatch[1].length / 2), 2) + 1
      const content = inlineMarkdown(bulletMatch[2])
      if (!inList) {
        out += '<ul style="margin:0 0 0.5em 1.25em;padding:0"><li>' + content
        inList = true
        listDepth = 1
      } else if (indent > listDepth) {
        out += '<ul style="margin:0 0 0 1.25em;padding:0"><li>' + content
        listDepth = indent
      } else if (indent < listDepth) {
        closeListsTo(indent)
        out += '</li><li>' + content
      } else {
        out += '</li><li>' + content
      }
      continue
    }
    if (inList) { closeListsTo(0); inList = false }
    if (raw.trim()) {
      paraQueue.push(inlineMarkdown(raw))
    } else {
      flushPara()
    }
  }
  if (inList) closeListsTo(0)
  flushPara()
  return out
}

interface BuildOpts {
  week: string
  generatedAt: string
  editedBy?: string | null
  editedAt?: string | null
}

export function snapshotToDocsHtml(
  data: SnapshotPayload,
  currentProjects: Project[],
  opts: BuildOpts
): string {
  const blsFor = (u: WeeklyUpdate): string[] => {
    if (u.business_lines_parsed && u.business_lines_parsed.length > 0) return u.business_lines_parsed
    if (u.business_lines) {
      try { const p = JSON.parse(u.business_lines); return Array.isArray(p) ? p.filter(Boolean) : [u.business_lines] } catch { return [u.business_lines] }
    }
    return []
  }
  const primaryBL = (u: WeeklyUpdate) => u.primary_business_line || blsFor(u)[0] || 'General'

  type GP = {
    project_id: string
    project_name: string
    highlight?: WeeklyUpdate
    lowlight?: WeeklyUpdate
    fyis: WeeklyGeneral[]
    people: WeeklyGeneral[]
    allBLs: string[]
  }
  const blList: string[] = []
  const seen = new Set<string>()
  const byBL: Record<string, Map<string, GP>> = {}
  const ensure = (name: string) => { if (!seen.has(name)) { seen.add(name); blList.push(name); byBL[name] = new Map() } }

  const push = (u: WeeklyUpdate, kind: 'highlight' | 'lowlight') => {
    const bl = primaryBL(u)
    ensure(bl)
    const existing = byBL[bl].get(u.project_id)
    if (existing) {
      existing[kind] = u
      if (existing.allBLs.length < 2) existing.allBLs = blsFor(u)
    } else {
      byBL[bl].set(u.project_id, {
        project_id: u.project_id,
        project_name: u.project_name || 'Unknown',
        [kind]: u,
        fyis: [],
        people: [],
        allBLs: blsFor(u),
      } as GP)
    }
  }
  ;(data.highlights || []).forEach(u => push(u, 'highlight'))
  ;(data.lowlights || []).forEach(u => push(u, 'lowlight'))

  const attach = (e: WeeklyGeneral, kind: 'fyis' | 'people') => {
    if (!e.project_id) return
    for (const bl of blList) {
      const gp = byBL[bl].get(e.project_id)
      if (gp) { gp[kind].push(e); return }
    }
    const proj = currentProjects.find(p => p.id === e.project_id)
    const bls = proj?.businessLines || []
    const bl = bls[0] || 'General'
    ensure(bl)
    const card: GP = {
      project_id: e.project_id,
      project_name: e.project_name || proj?.name || 'Unknown',
      fyis: [], people: [], allBLs: bls,
    }
    card[kind].push(e)
    byBL[bl].set(e.project_id, card)
  }
  ;(data.projectFyis || []).forEach(e => attach(e, 'fyis'))
  ;(data.projectPeople || []).forEach(e => attach(e, 'people'))
  // "General" sorts first; everything else alphabetical. Keeps general-BL
  // projects pinned to the top regardless of how the rest of the BLs sort.
  blList.sort((a, b) => {
    if (a === 'General' && b !== 'General') return -1
    if (b === 'General' && a !== 'General') return 1
    return a.localeCompare(b)
  })

  // Colors for category labels — chosen to read well in Docs on both white
  // and dark themes (Docs usually renders on white though).
  const COLOR = {
    highlight: '#137333',
    lowlight: '#c5221f',
    fyi: '#b06000',
    people: '#6a1b9a',
    muted: '#5f6368',
  }

  let html = `<div style="font-family:'Google Sans','Arial',sans-serif;font-size:11pt;line-height:1.5;color:#202124">`

  // Header
  const genDate = new Date(opts.generatedAt)
  const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  html += `<h1 style="font-size:20pt;font-weight:700;margin:0 0 0.25em">W&amp;I Weekly Status</h1>`
  html += `<p style="margin:0 0 1em;color:${COLOR.muted};font-size:10pt">${escapeHtml(dateStr)}</p>`
  if (opts.editedAt) {
    const editedDate = new Date(opts.editedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const editor = opts.editedBy ? opts.editedBy.split('@')[0] : 'admin'
    html += `<p style="margin:0 0 1em;color:${COLOR.muted};font-size:9pt;font-style:italic">Edited by ${escapeHtml(editor)} · ${escapeHtml(editedDate)}</p>`
  }

  // General notes
  const genHL = data.generalHighlights || []
  const genLL = data.generalLowlights || []
  const fi = data.fyis || []
  const pu = data.peopleUpdates || []
  const hasGeneral = genHL.length + genLL.length + fi.length + pu.length > 0
  const renderGeneralList = (items: WeeklyGeneral[]) => {
    if (items.length === 0) return ''
    return `<ul style="margin:0 0 0.75em 1.25em;padding:0">` +
      items.map(e => `<li>${inlineMarkdown(e.content || '')}</li>`).join('') +
      `</ul>`
  }

  if (hasGeneral) {
    html += `<h2 style="font-size:14pt;font-weight:700;margin:1.25em 0 0.5em;padding-bottom:0.2em;border-bottom:1px solid #dadce0">General notes</h2>`
    if (genHL.length > 0) {
      html += `<h3 style="font-size:11pt;font-weight:600;margin:0.75em 0 0.25em;color:${COLOR.highlight};text-transform:uppercase;letter-spacing:0.05em">Highlights</h3>`
      html += renderGeneralList(genHL)
    }
    if (genLL.length > 0) {
      html += `<h3 style="font-size:11pt;font-weight:600;margin:0.75em 0 0.25em;color:${COLOR.lowlight};text-transform:uppercase;letter-spacing:0.05em">Lowlights</h3>`
      // Each general lowlight gets its own block so Risk/Resolution sub-lines
      // attach to the correct entry, matching the project-lowlight shape.
      for (const e of genLL) {
        html += `<div style="margin:0 0 0.75em 0;padding-left:0.6em;border-left:3px solid ${COLOR.lowlight}">`
        html += `<div>${inlineMarkdown(e.content || '')}</div>`
        if (e.risk_reason) {
          html += `<p style="margin:0.25em 0 0"><strong>Risk:</strong> ${inlineMarkdown(e.risk_reason)}</p>`
        }
        if (e.resolution) {
          html += `<p style="margin:0.25em 0 0"><strong>Resolution:</strong> ${inlineMarkdown(e.resolution)}</p>`
        }
        html += `</div>`
      }
    }
    if (fi.length > 0) {
      html += `<h3 style="font-size:11pt;font-weight:600;margin:0.75em 0 0.25em;color:${COLOR.fyi};text-transform:uppercase;letter-spacing:0.05em">FYIs</h3>`
      html += renderGeneralList(fi)
    }
    if (pu.length > 0) {
      html += `<h3 style="font-size:11pt;font-weight:600;margin:0.75em 0 0.25em;color:${COLOR.people};text-transform:uppercase;letter-spacing:0.05em">People</h3>`
      html += renderGeneralList(pu)
    }
  }

  // Business-line sections
  for (const bl of blList) {
    const projects = Array.from(byBL[bl].values()).sort((a, b) => a.project_name.localeCompare(b.project_name))
    html += `<h2 style="font-size:14pt;font-weight:700;margin:1.5em 0 0.5em;padding-bottom:0.2em;border-bottom:1px solid #dadce0">${escapeHtml(bl)}</h2>`
    for (const gp of projects) {
      const proj = currentProjects.find(p => p.id === gp.project_id)
      const designers = proj?.designers && proj.designers.length > 0
        ? proj.designers
        : (gp.highlight?.designer_name || gp.lowlight?.designer_name ? [String(gp.highlight?.designer_name || gp.lowlight?.designer_name)] : [])
      const links = [
        proj?.deckLink && { name: proj.deckName || 'Deck', url: proj.deckLink },
        proj?.prdLink && { name: proj.prdName || 'PRD', url: proj.prdLink },
        proj?.briefLink && { name: proj.briefName || 'Brief', url: proj.briefLink },
        proj?.figmaLink && { name: 'Figma', url: proj.figmaLink },
        ...(proj?.customLinks || []),
      ].filter(Boolean) as { name: string; url: string }[]
      const otherBLs = gp.allBLs.filter(x => x !== bl)

      html += `<h3 style="font-size:12pt;font-weight:700;margin:1em 0 0.25em">${escapeHtml(gp.project_name)}</h3>`
      if (designers.length > 0) {
        html += `<p style="margin:0;color:${COLOR.muted};font-size:10pt">${escapeHtml(designers.map(d => d.split(' ')[0]).join(', '))}</p>`
      }
      if (otherBLs.length > 0) {
        html += `<p style="margin:0;color:${COLOR.muted};font-size:9pt">Also in: ${escapeHtml(otherBLs.join(', '))}</p>`
      }
      if (links.length > 0) {
        html += `<p style="margin:0.25em 0 0.5em;font-size:10pt">` +
          links.map(l => `<a href="${escapeHtml(l.url)}" style="color:#1155cc;text-decoration:underline">${escapeHtml(l.name)}</a>`).join(' · ') +
          `</p>`
      }
      if (gp.highlight?.description) {
        html += `<p style="margin:0.5em 0 0.25em;color:${COLOR.highlight};font-weight:700;font-size:10pt;text-transform:uppercase;letter-spacing:0.05em">Highlight</p>`
        html += renderBody(gp.highlight.description)
      }
      if (gp.lowlight?.description) {
        html += `<p style="margin:0.5em 0 0.25em;color:${COLOR.lowlight};font-weight:700;font-size:10pt;text-transform:uppercase;letter-spacing:0.05em">Lowlight</p>`
        html += renderBody(gp.lowlight.description)
        if (gp.lowlight.risk_reason) {
          html += `<p style="margin:0.25em 0 0"><strong>Risk:</strong> ${inlineMarkdown(gp.lowlight.risk_reason)}</p>`
        }
        if (gp.lowlight.resolution) {
          html += `<p style="margin:0.25em 0 0"><strong>Resolution:</strong> ${inlineMarkdown(gp.lowlight.resolution)}</p>`
        }
      }
      if (gp.fyis.length > 0) {
        html += `<p style="margin:0.5em 0 0.25em;color:${COLOR.fyi};font-weight:700;font-size:10pt;text-transform:uppercase;letter-spacing:0.05em">FYI</p>`
        for (const e of gp.fyis) html += renderBody(e.content || '')
      }
      if (gp.people.length > 0) {
        html += `<p style="margin:0.5em 0 0.25em;color:${COLOR.people};font-weight:700;font-size:10pt;text-transform:uppercase;letter-spacing:0.05em">People</p>`
        for (const e of gp.people) html += renderBody(e.content || '')
      }
    }
  }

  html += `</div>`
  return html
}

// Clipboard copy using the generated HTML. Plain-text fallback is a simple
// tag-stripped version so non-rich-text pastes (terminal, Slack code blocks)
// still get something readable.
export function copySnapshotToDocs(html: string): Promise<void> {
  // Strip tags but preserve line structure for plain-text paste.
  const plain = html
    .replace(/<\/(h1|h2|h3|p|li|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const htmlBlob = new Blob([html], { type: 'text/html' })
  const textBlob = new Blob([plain], { type: 'text/plain' })
  return navigator.clipboard.write([
    new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
  ])
}
