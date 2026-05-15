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

const projectUrl = (project_id: string | null, baseUrl: string): string | null => {
  if (!project_id) return null
  return `${baseUrl}/?project=${encodeURIComponent(project_id)}`
}

const projectLinks = (project_id: string | null, projects: Project[]): { name: string; url: string }[] => {
  if (!project_id) return []
  const proj = projects.find(p => p.id === project_id)
  if (!proj) return []
  return [
    proj.deckLink && { name: proj.deckName || 'Deck', url: proj.deckLink },
    proj.prdLink && { name: proj.prdName || 'PRD', url: proj.prdLink },
    proj.briefLink && { name: proj.briefName || 'Brief', url: proj.briefLink },
    proj.figmaLink && { name: 'Figma', url: proj.figmaLink },
    ...(proj.customLinks || []),
  ].filter(Boolean) as { name: string; url: string }[]
}

const renderBites = (label: string, color: string, items: ExecBite[]): string => {
  if (items.length === 0) return ''
  let html = `<p style="margin:0.4em 0 0.15em;color:${color};font-weight:700;font-size:9.5pt;text-transform:uppercase;letter-spacing:0.05em">${label}</p>`
  html += `<ul style="margin:0 0 0.5em 1.25em;padding:0">`
  for (const b of items) {
    html += `<li style="margin:0 0 0.15em">${escapeHtml(b.bite)}`
    if (b.risk) html += `<br><span style="font-size:9.5pt;color:${COLOR.muted}"><strong>Risk:</strong> ${escapeHtml(b.risk)}</span>`
    if (b.resolution) html += `<br><span style="font-size:9.5pt;color:${COLOR.muted}"><strong>Path:</strong> ${escapeHtml(b.resolution)}</span>`
    html += `</li>`
  }
  html += `</ul>`
  return html
}

const renderProject = (gp: ExecProject, projects: Project[], appBaseUrl: string): string => {
  const url = projectUrl(gp.project_id, appBaseUrl)
  const name = gp.project_name || 'General'
  const links = projectLinks(gp.project_id, projects)
  let html = `<p style="margin:0.75em 0 0.1em;font-size:11pt;font-weight:700">`
  if (url) {
    html += `<a href="${escapeHtml(url)}" style="color:#1155cc;text-decoration:underline">${escapeHtml(name)}</a>`
  } else {
    html += escapeHtml(name)
  }
  html += `</p>`
  if (gp.designers.length > 0) {
    html += `<p style="margin:0;color:${COLOR.muted};font-size:9.5pt">${escapeHtml(gp.designers.map(d => d.split(' ')[0]).join(', '))}</p>`
  }
  if (links.length > 0) {
    html += `<p style="margin:0;font-size:9.5pt">` +
      links.map(l => `<a href="${escapeHtml(l.url)}" style="color:#1155cc;text-decoration:underline">${escapeHtml(l.name)}</a>`).join(' · ') +
      `</p>`
  }
  html += renderBites('Highlight', COLOR.highlight, gp.highlights)
  html += renderBites('Lowlight', COLOR.lowlight, gp.lowlights)
  html += renderBites('FYI', COLOR.fyi, gp.fyis)
  html += renderBites('People', COLOR.people, gp.people)
  return html
}

export const execSummaryToDocsHtml = (
  summary: ExecSummary,
  projects: Project[],
  appBaseUrl: string,
): string => {
  const genDate = new Date(summary.generated_at)
  const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  let html = `<div style="font-family:'Google Sans','Arial',sans-serif;font-size:11pt;line-height:1.45;color:#202124">`
  html += `<h1 style="font-size:18pt;font-weight:700;margin:0 0 0.25em">Executive Summary — ${escapeHtml(summary.week)}</h1>`
  html += `<p style="margin:0 0 1em;color:${COLOR.muted};font-size:9.5pt">${escapeHtml(dateStr)} · ${escapeHtml(summary.model)}</p>`
  for (const bl of summary.business_lines) {
    html += `<h2 style="font-size:13pt;font-weight:700;margin:1.25em 0 0.4em;padding-bottom:0.15em;border-bottom:1px solid #dadce0">${escapeHtml(bl.business_line)}</h2>`
    const generalHasContent = bl.general.highlights.length || bl.general.lowlights.length || bl.general.fyis.length || bl.general.people.length
    if (generalHasContent) html += renderProject(bl.general, projects, appBaseUrl)
    for (const gp of bl.projects) html += renderProject(gp, projects, appBaseUrl)
  }
  html += `</div>`
  return html
}
