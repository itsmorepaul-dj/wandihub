// Clipboard-ready HTML for the Executive Summary report.
// Target: Google Docs / Google Sheets paste. Output is intentionally compact —
// each project is one line per soundbite category so the result is easy to
// drop into a spreadsheet row or read as a tight digest in Docs.

import type { Project } from '../types'

export interface ExecBite { id: string; bite: string; risk?: string; resolution?: string }
export interface ExecProject {
  project_id: string | null
  project_name: string | null
  designers: string[]
  highlights: ExecBite[]
  lowlights: ExecBite[]
  fyis: ExecBite[]
  people: ExecBite[]
}
export interface ExecBLGroup {
  business_line: string
  general: ExecProject
  projects: ExecProject[]
}
export interface ExecSummary {
  week: string
  generated_at: string
  model: string
  business_lines: ExecBLGroup[]
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const COLOR = {
  highlight: '#137333',
  lowlight: '#c5221f',
  fyi: '#b06000',
  people: '#6a1b9a',
  muted: '#5f6368',
}

// Hash-route filter that opens the Projects view scoped to a single project
// name. Mirrors the in-app convention in App.tsx (used elsewhere when copying
// per-project links into reports). project_id won't work — the route reads
// project_name from the query string.
const projectUrl = (project_name: string | null, baseUrl: string): string | null => {
  if (!project_name) return null
  return `${baseUrl}/#/projects?project=${encodeURIComponent(project_name)}`
}

// Linkify bite text for Docs paste: turns [label](url) markdown into anchors
// and bare http(s) URLs into anchors. Escape order matters — escape first,
// then run the patterns against the escaped text (the regex tokens use only
// ASCII so they don't collide with HTML entities).
const linkifyBite = (text: string): string => {
  let s = escapeHtml(text)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, label, url) => `<a href="${url}" style="color:#1155cc;text-decoration:underline">${label}</a>`)
  // Bare URLs that aren't already inside an href="..." attribute. The lookbehind
  // skips anything immediately preceded by `="` (i.e. inside an attribute).
  s = s.replace(/(?<!href=")(https?:\/\/[^\s<)]+)/g,
    (_m, url) => `<a href="${url}" style="color:#1155cc;text-decoration:underline">${url}</a>`)
  return s
}

// Paragraph spacing rules tuned for Google Docs paste fidelity. Values are in
// points so Docs maps them 1:1 to its "Spacing before/after" controls.
//   Category title (Lowlight/FYI/People label): before 16, after 4
//   Project title:                                before 16, after 0
//   Designer line:                                before 0,  after 4
//   Description / bite paragraphs:                before 0,  after 8
// All paragraphs use line-height 1.5 (Docs "1.5" line spacing).
const STYLE = {
  category: 'margin:16pt 0 4pt;line-height:1.5;font-weight:700;font-size:9.5pt;text-transform:uppercase;letter-spacing:0.05em',
  project: 'margin:16pt 0 0;line-height:1.5;font-size:11pt;font-weight:700',
  designer: `margin:0 0 4pt;line-height:1.5;color:${COLOR.muted};font-size:9.5pt`,
  bite: 'margin:0 0 8pt;line-height:1.0',
}

const renderBites = (label: string | null, color: string, items: ExecBite[]): string => {
  if (items.length === 0) return ''
  let html = ''
  if (label) {
    html += `<p style="${STYLE.category};color:${color}">${label}</p>`
  }
  // Each bite is a flush-left paragraph. Google Docs respects <p> margins
  // and treats them as normal paragraphs (no list indent, no bullet).
  for (const b of items) {
    html += `<p style="${STYLE.bite}">${linkifyBite(b.bite)}`
    if (b.risk) html += `<br><span style="font-size:9.5pt;color:${COLOR.muted}"><strong>Risk:</strong> ${linkifyBite(b.risk)}</span>`
    if (b.resolution) html += `<br><span style="font-size:9.5pt;color:${COLOR.muted}"><strong>Path:</strong> ${linkifyBite(b.resolution)}</span>`
    html += `</p>`
  }
  return html
}

const renderProject = (gp: ExecProject, appBaseUrl: string): string => {
  const url = projectUrl(gp.project_name, appBaseUrl)
  const name = gp.project_name || 'General'
  let html = `<div>`
  html += `<p style="${STYLE.project}">`
  if (url) {
    html += `<a href="${escapeHtml(url)}" style="color:#1155cc;text-decoration:underline">${escapeHtml(name)}</a>`
  } else {
    html += escapeHtml(name)
  }
  html += `</p>`
  if (gp.designers.length > 0) {
    html += `<p style="${STYLE.designer}">${escapeHtml(gp.designers.map(d => d.split(' ')[0]).join(', '))}</p>`
  }
  html += renderBites(null, COLOR.highlight, gp.highlights)
  html += renderBites('Lowlight', COLOR.lowlight, gp.lowlights)
  html += renderBites('FYI', COLOR.fyi, gp.fyis)
  html += renderBites('People', COLOR.people, gp.people)
  html += `</div>`
  return html
}

export const execSummaryToDocsHtml = (
  summary: ExecSummary,
  // `projects` was used to render auxiliary Deck/PRD/Brief/Figma links per
  // project; per Paul's feedback those are intentionally dropped. Param kept
  // for signature stability with existing call sites.
  _projects: Project[],
  appBaseUrl: string,
): string => {
  const genDate = new Date(summary.generated_at)
  const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  let html = `<div style="font-family:'Google Sans','Arial',sans-serif;font-size:11pt;line-height:1.45;color:#202124">`
  html += `<h1 style="font-size:18pt;font-weight:700;margin:0 0 0.25em">W&amp;I Weekly Status</h1>`
  html += `<p style="margin:0 0 1em;color:${COLOR.muted};font-size:9.5pt">${escapeHtml(dateStr)}</p>`
  for (const bl of summary.business_lines) {
    // The "General" BL renders as "General notes" to match the in-app
    // section heading. Project-less items here are shown without an extra
    // project block; they're emitted directly under the heading.
    const headingLabel = bl.business_line === 'General' ? 'General notes' : bl.business_line
    html += `<h2 style="font-size:13pt;font-weight:700;margin:1.25em 0 0.4em;padding-bottom:0.15em;border-bottom:1px solid #dadce0">${escapeHtml(headingLabel)}</h2>`
    const generalHasContent = bl.general.highlights.length || bl.general.lowlights.length || bl.general.fyis.length || bl.general.people.length
    if (generalHasContent) html += renderProject(bl.general, appBaseUrl)
    for (const gp of bl.projects) html += renderProject(gp, appBaseUrl)
  }
  html += `</div>`
  return html
}
