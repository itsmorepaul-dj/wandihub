import React, { useState, useMemo } from 'react'
import { ClipboardCopy, Pencil, Save, X } from 'lucide-react'
import type { Project, WeeklyUpdate, WeeklyGeneral, ProjectImage, SnapshotThumbnail } from './types'
import RichTextEditor from './components/RichTextEditor'

// One snapshot's raw payload (the parsed data_json shape emitted by the server).
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

export interface SnapshotMeta {
  week: string
  generated_at: string
  edited_by?: string | null
  edited_at?: string | null
}

interface Props {
  meta: SnapshotMeta
  initialData: SnapshotPayload
  currentProjects: Project[]
  isAdmin: boolean
  onSectionCopy: (text: string) => void
  renderMarkdownLinks: (text: string) => React.ReactNode
  /** Patch the snapshot's data_json on the server and return the saved row. */
  onAdminSave: (dataJson: SnapshotPayload) => Promise<SnapshotMeta>
  /** Open the app-wide lightbox for a thumbnail gallery. If omitted, thumbs
   * fall back to opening the raw image URL in a new tab. */
  onOpenLightbox?: (images: ProjectImage[], index: number) => void
}

const slugForBL = (name: string) => `bl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`

// Thin wrapper around the existing RichTextEditor so snapshot admin edits have
// the same bold / bullets / links UX as the project-card weekly form. Keeping
// it inline (vs. raw <RichTextEditor> at every call site) lets us tune the
// styling & placeholder once for all admin fields.
function AdminRTE({ value, onChange, placeholder, className }: {
  value: string
  onChange: (md: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <RichTextEditor
      className={`rr-admin-rte ${className || ''}`}
      value={value}
      onChange={onChange}
      placeholder={placeholder || ''}
      features={['bold', 'bullets', 'links']}
      minHeight="4rem"
    />
  )
}

export default function SnapshotReportView({
  meta, initialData, currentProjects, isAdmin,
  onSectionCopy, renderMarkdownLinks, onAdminSave, onOpenLightbox,
}: Props) {
  // Adapt snapshot thumbnails ({id, filename, caption}) to ProjectImage so
  // they can be handed to the shared ImageLightbox without refetching.
  const toLightboxImages = (thumbs: SnapshotThumbnail[], projectId: string): ProjectImage[] =>
    thumbs.map(t => ({
      id: t.id,
      project_id: projectId,
      filename: t.filename,
      original_name: t.filename,
      mime_type: '',
      size_bytes: 0,
      caption: t.caption || '',
      created_at: '',
    }))
  const [data, setData] = useState<SnapshotPayload>(initialData)
  const [editMode, setEditMode] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [currentMeta, setCurrentMeta] = useState(meta)

  // Resolve the BL list for an update. Newer snapshots bake business_lines_parsed
  // at generate time; older snapshots only have the raw JSON string.
  const blsFor = (u: WeeklyUpdate): string[] => {
    if (u.business_lines_parsed && u.business_lines_parsed.length > 0) return u.business_lines_parsed
    if (u.business_lines) {
      try { const p = JSON.parse(u.business_lines); return Array.isArray(p) ? p.filter(Boolean) : [u.business_lines] } catch { return [u.business_lines] }
    }
    return []
  }
  const primaryBLFor = (u: WeeklyUpdate): string => u.primary_business_line || blsFor(u)[0] || 'General'

  // Rebuild BL-grouped view whenever data changes (edit mode toggles a single
  // draft, save replaces `data`).
  const { bls, projectsByBL, hasGeneralNotes } = useMemo(() => {
    type GP = {
      key: string
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
    const map: Record<string, Map<string, GP>> = {}
    const ensure = (name: string) => {
      if (!seen.has(name)) { seen.add(name); blList.push(name); map[name] = new Map() }
    }
    const push = (u: WeeklyUpdate, kind: 'highlight' | 'lowlight') => {
      const bl = primaryBLFor(u)
      ensure(bl)
      const existing = map[bl].get(u.project_id)
      if (existing) {
        existing[kind] = u
        if (existing.allBLs.length < 2) existing.allBLs = blsFor(u)
      } else {
        map[bl].set(u.project_id, {
          key: u.project_id,
          project_id: u.project_id,
          project_name: u.project_name || 'Unknown',
          [kind]: u,
          fyis: [],
          people: [],
          allBLs: blsFor(u),
        } as GP)
      }
    }
    const hl = data.highlights || []
    const ll = data.lowlights || []
    hl.forEach(u => push(u, 'highlight'))
    ll.forEach(u => push(u, 'lowlight'))
    const attach = (e: WeeklyGeneral, kind: 'fyis' | 'people') => {
      if (!e.project_id) return
      for (const bl of blList) {
        const gp = map[bl].get(e.project_id)
        if (gp) { gp[kind].push(e); return }
      }
      const proj = currentProjects.find(p => p.id === e.project_id)
      const projectBLs = proj?.businessLines || []
      const bl = projectBLs[0] || 'General'
      ensure(bl)
      const card: GP = {
        key: e.project_id,
        project_id: e.project_id,
        project_name: e.project_name || proj?.name || 'Unknown',
        fyis: [],
        people: [],
        allBLs: projectBLs,
      }
      card[kind].push(e)
      map[bl].set(e.project_id, card)
    }
    ;(data.projectFyis || []).forEach(e => attach(e, 'fyis'))
    ;(data.projectPeople || []).forEach(e => attach(e, 'people'))
    blList.sort((a, b) => a.localeCompare(b))
    const genHL = data.generalHighlights || []
    const genLL = data.generalLowlights || []
    const fi = data.fyis || []
    const pu = data.peopleUpdates || []
    const has = genHL.length > 0 || genLL.length > 0 || fi.length > 0 || pu.length > 0
    return { bls: blList, projectsByBL: map, hasGeneralNotes: has }
  }, [data, currentProjects])

  // Mutation helpers — all operate on the single `data` state object so the
  // whole edit session is atomic; Cancel just resets state to initialData.
  const patch = (fn: (d: SnapshotPayload) => SnapshotPayload) => setData(prev => fn({ ...prev }))

  const updateUpdateField = (projectId: string, type: 'highlight' | 'lowlight', field: 'description' | 'risk_reason' | 'resolution', value: string) => {
    patch(d => {
      const key = type === 'highlight' ? 'highlights' : 'lowlights'
      d[key] = (d[key] || []).map(u => u.project_id === projectId ? { ...u, [field]: value } : u)
      return d
    })
  }

  const updateProjectGeneralEntry = (entryId: string, category: 'fyi' | 'people', value: string) => {
    patch(d => {
      const key = category === 'fyi' ? 'projectFyis' : 'projectPeople'
      d[key] = (d[key] || []).map(e => e.id === entryId ? { ...e, content: value } : e)
      return d
    })
  }

  const updateGeneralEntry = (entryId: string, bucket: 'generalHighlights' | 'generalLowlights' | 'fyis' | 'peopleUpdates', value: string) => {
    patch(d => {
      d[bucket] = (d[bucket] || []).map(e => e.id === entryId ? { ...e, content: value } : e)
      return d
    })
  }

  const updateGeneralLowlightField = (entryId: string, field: 'risk_reason' | 'resolution', value: string) => {
    patch(d => {
      d.generalLowlights = (d.generalLowlights || []).map(e => e.id === entryId ? { ...e, [field]: value } : e)
      return d
    })
  }

  const beginEdit = () => {
    setData(initialData)
    setEditMode(true)
    setSaveState('idle')
  }
  const cancelEdit = () => {
    setData(initialData)
    setEditMode(false)
    setSaveState('idle')
  }
  const saveEdits = async () => {
    setSaveState('saving')
    try {
      const savedMeta = await onAdminSave(data)
      setCurrentMeta(savedMeta)
      setEditMode(false)
      setSaveState('idle')
    } catch (err) {
      console.error('Admin save failed:', err)
      setSaveState('error')
    }
  }

  const genDate = new Date(currentMeta.generated_at)
  const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const editedAtStr = currentMeta.edited_at
    ? new Date(currentMeta.edited_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  const editedByShort = currentMeta.edited_by ? currentMeta.edited_by.split('@')[0] : null

  const renderProjectLink = (projectName: string, bl: string) => {
    const params = new URLSearchParams()
    params.set('project', projectName)
    if (bl) params.append('bl', bl)
    return `#/projects?${params.toString()}`
  }

  const renderProjectCard = (gp: any, bl: string) => {
    const proj = currentProjects.find(p => p.id === gp.project_id)
    const sampleUpdate = gp.highlight || gp.lowlight!
    const thumbs = sampleUpdate.thumbnails || []
    const pastReviews = sampleUpdate.past_reviews || []
    const designers = proj?.designers && proj.designers.length > 0
      ? proj.designers
      : (sampleUpdate.designer_name ? [sampleUpdate.designer_name] : [])
    const links = [
      proj?.deckLink && { name: proj.deckName || 'Deck', url: proj.deckLink },
      proj?.prdLink && { name: proj.prdName || 'PRD', url: proj.prdLink },
      proj?.briefLink && { name: proj.briefName || 'Brief', url: proj.briefLink },
      proj?.figmaLink && { name: 'Figma', url: proj.figmaLink },
      ...(proj?.customLinks || []),
    ].filter(Boolean) as { name: string; url: string }[]
    const otherBLs = gp.allBLs.filter((x: string) => x !== bl)

    return (
      <div key={gp.key} className="rr-project-card">
        <a className="rr-project-name" href={renderProjectLink(gp.project_name, bl)}>{gp.project_name}</a>
        {otherBLs.length > 0 && (
          <div className="rr-project-also-in">Also in: {otherBLs.map((b: string, i: number) => (
            <span key={b}>{i > 0 && ', '}<a href={`#${slugForBL(b)}`}>{b}</a></span>
          ))}</div>
        )}
        {designers.length > 0 && (
          <div className="rr-project-designers">{designers.map((d: string) => d.split(' ')[0]).join(', ')}</div>
        )}
        {links.length > 0 && (
          <div className="rr-project-links">
            {links.map((l, i) => (
              <span key={i}>
                {i > 0 && <span className="rr-link-sep">·</span>}
                <a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a>
              </span>
            ))}
          </div>
        )}
        {gp.highlight && (
          <div className="rr-block rr-block-highlight">
            <div className="rr-block-label">Highlight</div>
            {editMode
              ? <AdminRTE placeholder="Highlight description" value={gp.highlight.description || ''} onChange={v => updateUpdateField(gp.project_id, 'highlight', 'description', v)} />
              : <div className="rr-block-body">{renderMarkdownLinks(gp.highlight.description)}</div>}
          </div>
        )}
        {gp.lowlight && (
          <div className="rr-block rr-block-lowlight">
            <div className="rr-block-label">Lowlight</div>
            {editMode
              ? <AdminRTE placeholder="Lowlight description" value={gp.lowlight.description || ''} onChange={v => updateUpdateField(gp.project_id, 'lowlight', 'description', v)} />
              : <div className="rr-block-body">{renderMarkdownLinks(gp.lowlight.description)}</div>}
            {(editMode || gp.lowlight.risk_reason) && (
              editMode
                ? <div className="rr-block-sub"><strong>Risk:</strong><AdminRTE placeholder="Risk" value={gp.lowlight.risk_reason || ''} onChange={v => updateUpdateField(gp.project_id, 'lowlight', 'risk_reason', v)} /></div>
                : <div className="rr-block-sub"><strong>Risk:</strong> {renderMarkdownLinks(gp.lowlight.risk_reason!)}</div>
            )}
            {(editMode || gp.lowlight.resolution) && (
              editMode
                ? <div className="rr-block-sub"><strong>Resolution:</strong><AdminRTE placeholder="Resolution" value={gp.lowlight.resolution || ''} onChange={v => updateUpdateField(gp.project_id, 'lowlight', 'resolution', v)} /></div>
                : <div className="rr-block-sub"><strong>Resolution:</strong> {renderMarkdownLinks(gp.lowlight.resolution!)}</div>
            )}
          </div>
        )}
        {gp.fyis.length > 0 && (
          <div className="rr-block rr-block-fyi">
            <div className="rr-block-label">FYI</div>
            {gp.fyis.map((e: WeeklyGeneral) => (
              editMode
                ? <AdminRTE key={e.id} placeholder="FYI" value={e.content || ''} onChange={v => updateProjectGeneralEntry(e.id, 'fyi', v)} />
                : <div key={e.id} className="rr-block-body">{renderMarkdownLinks(e.content)}</div>
            ))}
          </div>
        )}
        {gp.people.length > 0 && (
          <div className="rr-block rr-block-people">
            <div className="rr-block-label">People</div>
            {gp.people.map((e: WeeklyGeneral) => (
              editMode
                ? <AdminRTE key={e.id} placeholder="People" value={e.content || ''} onChange={v => updateProjectGeneralEntry(e.id, 'people', v)} />
                : <div key={e.id} className="rr-block-body">{renderMarkdownLinks(e.content)}</div>
            ))}
          </div>
        )}
        {thumbs.length > 0 && (
          <div className="rr-project-thumbs">
            {thumbs.map((t: SnapshotThumbnail, idx: number) => (
              onOpenLightbox ? (
                <button
                  key={t.id}
                  type="button"
                  className="rr-project-thumb"
                  onClick={() => onOpenLightbox(toLightboxImages(thumbs, gp.project_id), idx)}
                  title={t.caption || gp.project_name}
                >
                  <img src={`/api/images/${t.id}`} alt={t.caption || gp.project_name} loading="lazy" />
                </button>
              ) : (
                <a key={t.id} className="rr-project-thumb" href={`/api/images/${t.id}`} target="_blank" rel="noopener noreferrer">
                  <img src={`/api/images/${t.id}`} alt={t.caption || gp.project_name} loading="lazy" />
                </a>
              )
            ))}
          </div>
        )}
        {pastReviews.length > 0 && (
          <div className="rr-project-reviews">
            <span className="rr-project-reviews-label">Past reviews:</span>
            {pastReviews.map((r: any, i: number) => (
              <span key={r.reviewId}>
                {i > 0 && <span className="rr-link-sep">·</span>}
                <a href={`/review/${r.reviewId}?project=${encodeURIComponent(gp.project_id)}`} target="_blank" rel="noopener noreferrer">
                  {r.review_date ? new Date(r.review_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : (r.title || 'Review')}
                </a>
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  const renderGeneralList = (items: WeeklyGeneral[], emptyLabel: string, bucket: 'generalHighlights' | 'generalLowlights' | 'fyis' | 'peopleUpdates') => {
    // Copy per-entry only makes sense for highlights/lowlights where people
    // paste one line into a Slack message or design doc. FYIs and People
    // updates are consumed as a block, so the copy affordance was just noise.
    const allowCopy = bucket === 'generalHighlights' || bucket === 'generalLowlights'
    return items.length > 0 ? (
      <div className="rr-general-list">{items.map(e => (
        <div key={e.id} className="rr-general-item">
          {!editMode && allowCopy && <button className="rr-copy-entry" onClick={() => onSectionCopy(e.content.trim())} title="Copy entry"><ClipboardCopy size={11} /></button>}
          {editMode
            ? <AdminRTE placeholder={`${bucket} entry`} value={e.content || ''} onChange={v => updateGeneralEntry(e.id, bucket, v)} />
            : <span className="rr-general-text">{renderMarkdownLinks(e.content)}</span>}
        </div>
      ))}</div>
    ) : <div className="rr-empty">No {emptyLabel} this week.</div>
  }

  const generalHL = data.generalHighlights || []
  const generalLL = data.generalLowlights || []
  const fi = data.fyis || []
  const pu = data.peopleUpdates || []

  return (
    <div className="rr rr-v2">
      <header className="rr-header">
        <div className="rr-header-main">
          <div className="rr-week">{currentMeta.week}</div>
          <div className="rr-date">{dateStr}</div>
          {editedAtStr && (
            <span className="rr-edited-chip" title={`Edited ${editedAtStr}${editedByShort ? ` by ${editedByShort}` : ''}`}>
              Edited{editedByShort ? ` by ${editedByShort}` : ''} · {editedAtStr}
            </span>
          )}
        </div>
        {isAdmin && (
          <div className="rr-header-actions">
            {editMode ? (
              <>
                <button className="rr-admin-btn rr-admin-btn-primary" onClick={saveEdits} disabled={saveState === 'saving'}>
                  <Save size={12} /> {saveState === 'saving' ? 'Saving…' : 'Save edits'}
                </button>
                <button className="rr-admin-btn" onClick={cancelEdit} disabled={saveState === 'saving'}>
                  <X size={12} /> Cancel
                </button>
                {saveState === 'error' && <span className="rr-admin-error">Save failed</span>}
              </>
            ) : (
              <button className="rr-admin-btn" onClick={beginEdit} title="Edit this report's text">
                <Pencil size={12} /> Edit report
              </button>
            )}
          </div>
        )}
      </header>

      {(hasGeneralNotes || bls.length > 0) && (
        <nav className="rr-nav" aria-label="Jump to section">
          {hasGeneralNotes && <a href="#rr-general-notes">General notes</a>}
          {bls.map(bl => (
            <a key={bl} href={`#${slugForBL(bl)}`}>{bl}</a>
          ))}
        </nav>
      )}

      {hasGeneralNotes && (
        <section id="rr-general-notes" className="rr-bl-section rr-general-section">
          <h2 className="rr-bl-title">General notes</h2>
          {generalHL.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-highlight">Highlights</h3>
              {renderGeneralList(generalHL, 'general highlights', 'generalHighlights')}
            </div>
          )}
          {generalLL.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-lowlight">Lowlights</h3>
              <div className="rr-general-lowlight-list">
                {generalLL.map(e => (
                  <div key={e.id} className="rr-block rr-block-lowlight rr-general-lowlight">
                    {!editMode && (
                      <button className="rr-copy-entry" onClick={() => onSectionCopy(e.content.trim())} title="Copy entry">
                        <ClipboardCopy size={11} />
                      </button>
                    )}
                    {editMode
                      ? <AdminRTE placeholder="Lowlight description" value={e.content || ''} onChange={v => updateGeneralEntry(e.id, 'generalLowlights', v)} />
                      : <div className="rr-block-body">{renderMarkdownLinks(e.content)}</div>}
                    {(editMode || e.risk_reason) && (
                      editMode
                        ? <div className="rr-block-sub"><strong>Risk:</strong><AdminRTE placeholder="Risk" value={e.risk_reason || ''} onChange={v => updateGeneralLowlightField(e.id, 'risk_reason', v)} /></div>
                        : <div className="rr-block-sub"><strong>Risk:</strong> {renderMarkdownLinks(e.risk_reason!)}</div>
                    )}
                    {(editMode || e.resolution) && (
                      editMode
                        ? <div className="rr-block-sub"><strong>Resolution:</strong><AdminRTE placeholder="Resolution" value={e.resolution || ''} onChange={v => updateGeneralLowlightField(e.id, 'resolution', v)} /></div>
                        : <div className="rr-block-sub"><strong>Resolution:</strong> {renderMarkdownLinks(e.resolution!)}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {fi.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-fyi">FYIs</h3>
              {renderGeneralList(fi, 'FYIs', 'fyis')}
            </div>
          )}
          {pu.length > 0 && (
            <div className="rr-subsection">
              <h3 className="rr-subsection-title rr-subsection-people">People</h3>
              {renderGeneralList(pu, 'people updates', 'peopleUpdates')}
            </div>
          )}
        </section>
      )}

      {bls.length === 0 && !hasGeneralNotes && (
        <div className="rr-empty">No updates recorded for {currentMeta.week}.</div>
      )}

      {bls.map(bl => {
        const projects = Array.from(projectsByBL[bl].values())
          .sort((a, b) => a.project_name.localeCompare(b.project_name))
        return (
          <section key={bl} id={slugForBL(bl)} className="rr-bl-section">
            <h2 className="rr-bl-title">{bl}</h2>
            <div className="rr-project-grid">
              {projects.map(gp => renderProjectCard(gp, bl))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
