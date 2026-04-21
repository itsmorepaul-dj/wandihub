import { useState, useEffect, useRef } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { Pencil, Trash2, FileText, Presentation, FileEdit, Mail, MessageSquare, LayoutGrid, Users, Calendar, Figma, Link as LinkIcon, Search, Gauge, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Settings, GripVertical, Folder, StickyNote, RefreshCw, User, CheckSquare, Sun, Moon, Edit2, Bell, Loader, Clock, ClipboardCopy, BarChart3, FileBarChart, ListChecks, Palette, HelpCircle, AlertTriangle, Flag, Info, Archive, RotateCcw, ChevronLeft, Copy, Globe } from 'lucide-react'
import { Tooltip } from './Tooltip'
import './App.css'
import type { TimelineRange, Project, BusinessLine, TeamMember, Note, CalendarEvent, CalendarDay, CalendarMonth, CalendarData, CapacityMember, CapacityAssignment, CapacityData, ActivityItem, TabId, WeeklyUpdate, WeeklyGeneral, ProjectImage } from './types'
import WeeklyUpdateForm from './WeeklyUpdateForm'
import RichTextEditor from './components/RichTextEditor'
import { copyRichText } from './utils/richtext'
import ImageLightbox from './ImageLightbox'
import { defaultHolidays, getTodayStr, getDjFiscalLabel, DAY_MS, parseLocalDate, formatShortDate, formatFullDate, calcRangeHours, getClosestTimeOff, formatDateRange, formatMonthDay, formatMonthDayFromDate, getTodayFormatted, formatVersionDisplay } from './utils'
import { authFetch, setClientVersion, getClientVersion, defaultBrandOptions, loadDataFromAPI } from './api'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { SortablePriorityItem, SortableDoneItem, SortableTimelineItem, InProgressDropZone, DoneDropZone } from './components/Sortable'

// Recent updates shown on login screen
const CHANGELOG = [
  'Public review site — reprioritized the project card for review: description and links lead, with the project schedule (gantt) collapsed into an "Open Project Schedule" accordion that matches the "Open Notes" treatment. Card numbers rendered as red circles with white text. Attached project links use a conventional blue color with underline so they read as clickable. Markdown links in descriptions and the review page header now render as clickable anchors instead of raw `[text](url)`. Uploaded images can be reordered via drag handle on each thumbnail in the notes panel, and the delete button now uses the same trash icon as the project edit modal.',
  'Filter-aware summary — the Projects summary stats and risk warnings now reflect the active sort/filter, so filtering by designer or business line scopes the counts to the visible subset. Moved below the sort/filter controls to reinforce that it reflects those settings. Archive button matched to the sort button height.',
]


function renderMarkdownLinks(text: string): React.ReactNode {
  const renderInline = (line: string, lineIdx: number) => {
    const parts: React.ReactNode[] = []
    let last = 0
    const inlineRe = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = inlineRe.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index))
      if (m[1] !== undefined) {
        parts.push(<strong key={`${lineIdx}-b-${m.index}`}>{m[1]}</strong>)
      } else {
        parts.push(
          <a key={`${lineIdx}-${m.index}`} href={m[3]} target="_blank" rel="noopener noreferrer" className="weekly-inline-link"
            onClick={e => e.stopPropagation()}>{m[2]}</a>
        )
      }
      last = m.index + m[0].length
    }
    if (last < line.length) parts.push(line.slice(last))
    return parts.length > 0 ? parts : [line]
  }
  const lines = text.split('\n')
  return <>{lines.map((line, i) => {
    const bulletMatch = line.match(/^(\s*)- (.*)/)
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2)
      return <div key={i} className="rte-bullet" data-indent={Math.min(indent, 3)}>{renderInline(bulletMatch[2], i)}</div>
    }
    return <div key={i}>{line ? renderInline(line, i) : <br />}</div>
  })}</>
}

// Parse Gemini note content_preview to extract structured sections
// Highlight projects and people in text with clickable + buttons to add links
function highlightTextWithLinks(
  text: string,
  projects: Project[],
  _team: TeamMember[],
  linkedProjectIds: string[],
  _linkedTeamIds: string[],
  onAddProject: (id: string) => void,
  _onAddPerson: (id: string) => void
): React.ReactNode {
  if (!text) return null
  
  const cleanText = text.replace(/\u200B/g, '').trim()
  if (!cleanText) return null

  // Build regex patterns for all projects and team members not yet linked
  const unlinkedProjects = projects.filter(p => !linkedProjectIds.includes(p.id))
  // Create regex that matches project names (case insensitive)
  const projectNames = unlinkedProjects.map(p => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  const allNames = [...projectNames]
  if (allNames.length === 0) return cleanText
  
  // Sort by length descending to match longer names first
  allNames.sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${allNames.join('|')})`, 'gi')
  
  const parts = cleanText.split(pattern)
  
  return parts.map((part, i) => {
    const lowerPart = part.toLowerCase()
    
    // Check if this part matches an unlinked project
    const matchedProject = unlinkedProjects.find(p => p.name.toLowerCase() === lowerPart)
    if (matchedProject) {
      return (
        <span key={i} className="highlighted-project" style={{ backgroundColor: '#dbeafe', padding: '1px 4px', borderRadius: '3px', cursor: 'pointer', margin: '0 2px' }}>
          {part}
          <button 
            onClick={() => onAddProject(matchedProject.id)}
            style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', marginLeft: '2px', fontWeight: 'bold' }}
            title="Add project link"
          >+</button>
        </span>
      )
    }
    
    return part
  })
}

const VALID_TABS = ['projects', 'team', 'calendar', 'capacity', 'reports', 'reviews', 'settings'] as const

function parseHash(): { tab: TabId; params: URLSearchParams } {
  const hash = window.location.hash.replace(/^#\/?/, '')
  const [path, query] = hash.split('?')
  const tab = VALID_TABS.includes(path as TabId) ? (path as TabId) : 'projects'
  return { tab, params: new URLSearchParams(query || '') }
}

function CustomLinkRow({ link, onChange, onRemove }: {
  link: { name: string; url: string }
  onChange: (updated: { name: string; url: string }) => void
  onRemove: () => void
}) {
  const [local, setLocal] = useState(link)
  // Sync if parent changes (e.g. link added/removed shifting indices)
  useEffect(() => { setLocal(link) }, [link.name, link.url])
  return (
    <div className="custom-link-row" style={{ marginBottom: '0.5rem' }}>
      <div className={`float-field${local.name ? ' has-value' : ''}`}>
        <input type="text" value={local.name}
          onChange={e => setLocal(prev => ({ ...prev, name: e.target.value }))}
          onBlur={() => onChange(local)} placeholder=" " />
        <label>Link Name</label>
      </div>
      <div className={`float-field${local.url ? ' has-value' : ''}`}>
        <input type="url" value={local.url}
          onChange={e => setLocal(prev => ({ ...prev, url: e.target.value }))}
          onBlur={() => onChange(local)} placeholder=" " />
        <label>URL</label>
      </div>
      <button type="button" className="remove-link-btn" onClick={onRemove}>
        <Trash2 size={14} />
      </button>
    </div>
  )
}

const REVIEW_STATUS_MAP: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: '#3b82f6' },
  review: { label: 'In Review', color: '#f59e0b' },
  done: { label: 'Done', color: '#22c55e' },
  blocked: { label: 'Blocked', color: '#ef4444' },
  pending: { label: 'Pending', color: '#94a3b8' },
}

function WeeklyPendingEditor({ existing, placeholder, onSave, onDelete }: {
  existing: { id?: string; content: string } | undefined
  placeholder: string
  onSave: (content: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [value, setValue] = useState(existing?.content || '')
  const valueRef = useRef(value)
  valueRef.current = value
  useEffect(() => { setValue(existing?.content || '') }, [existing?.id])
  return (
    <RichTextEditor
      className="weekly-pending-rte"
      value={value}
      onChange={setValue}
      onBlur={async () => {
        const val = valueRef.current.trim()
        if (!val && !existing) return
        if (val === (existing?.content || '')) return
        if (!val && existing?.id) { await onDelete(existing.id); return }
        await onSave(val)
      }}
      placeholder={placeholder}
      features={['bold', 'bullets', 'links']}
      minHeight="calc(0.75rem * 1.45 * 3 + 0.6rem)"
    />
  )
}

function ReviewItemRow({ item, index, project, onRemove, authFetch }: {
  item: any
  index: number
  project: any
  onRemove: () => void
  authFetch: (url: string, opts?: RequestInit) => Promise<Response>
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const [desc, setDesc] = useState(item.description || '')

  const designers = project?.designers?.map((d: string) => d.split(' ')[0]).join(', ') || ''
  const statusInfo = REVIEW_STATUS_MAP[project?.status] || { label: project?.status || '—', color: '#6b7280' }
  const businessLines: string[] = project?.businessLines || (project?.businessLine ? (() => { try { return JSON.parse(project.businessLine) } catch { return [project.businessLine] } })() : [])

  const links: { label: string; url: string }[] = []
  if (project?.deckLink) links.push({ label: project.deckName || 'Deck', url: project.deckLink })
  if (project?.prdLink) links.push({ label: project.prdName || 'PRD', url: project.prdLink })
  if (project?.briefLink) links.push({ label: project.briefName || 'Brief', url: project.briefLink })
  if (project?.figmaLink) links.push({ label: 'Figma', url: project.figmaLink })
  if (project?.url) links.push({ label: 'JIRA', url: project.url })
  if (project?.customLinks) {
    for (const cl of project.customLinks) {
      if (cl.url) links.push({ label: cl.name || 'Link', url: cl.url })
    }
  }

  return (
    <tr ref={setNodeRef} style={style}>
      <td>
        <button type="button" className="action-btn drag-handle" {...attributes} {...listeners} tabIndex={-1}>
          <GripVertical size={14} />
        </button>
      </td>
      <td className="review-rank">{index + 1}</td>
      <td>
        <div className="review-item-project">
          <span className="review-item-name">{project?.name || 'Unknown'}</span>
          <span className="review-item-meta">
            <span className="review-status-pill" style={{ background: statusInfo.color }}>{statusInfo.label}</span>
            {designers && <span className="review-item-designers">{designers}</span>}
            {businessLines.length > 0 && <span className="review-item-bl">{businessLines.join(', ')}</span>}
          </span>
          <RichTextEditor
            className="review-item-rte"
            value={desc}
            onChange={setDesc}
            onBlur={async () => {
              if (desc !== (item.description || '')) {
                await authFetch(`/api/review-items/${item.id}/description`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ description: desc })
                })
              }
            }}
            placeholder="Add a description..."
            features={['bold', 'bullets', 'links']}
            minHeight="calc(0.75rem * 1.45 * 3 + 0.5rem)"
          />
        </div>
      </td>
      <td className="review-item-links">
        {links.length > 0 ? links.map((l, i) => (
          <span key={i}>
            <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
            {i < links.length - 1 && <span className="review-link-sep">·</span>}
          </span>
        )) : <span style={{ color: 'var(--color-text-dim)' }}>—</span>}
      </td>
      <td>
        <button className="action-btn delete" onClick={onRemove} title="Remove from review">
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  )
}

function SortableImageItem({ img, index, images, onOpenLightbox, onDelete, onCaptionBlur }: {
  img: ProjectImage
  index: number
  images: ProjectImage[]
  onOpenLightbox: (images: ProjectImage[], index: number) => void
  onDelete: (id: string) => void
  onCaptionBlur: (id: string, caption: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: img.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  return (
    <div ref={setNodeRef} style={style} className="project-image-item">
      <div className="project-image-thumb">
        <button type="button" className="project-image-drag" {...attributes} {...listeners} title="Drag to reorder" onClick={e => e.stopPropagation()}>
          <GripVertical size={12} />
        </button>
        <img src={`/api/images/${img.id}`} alt={img.caption || img.original_name} loading="lazy"
          onClick={() => onOpenLightbox(images, index)} />
        <button className="project-image-delete" onClick={() => onDelete(img.id)} title="Delete image">
          <Trash2 size={12} />
        </button>
      </div>
      <input className="project-image-caption" placeholder="Add caption..."
        defaultValue={img.caption || ''}
        onBlur={e => { if (e.target.value !== (img.caption || '')) onCaptionBlur(img.id, e.target.value) }} />
    </div>
  )
}

function App() {
  // Strip unused query params from URL (everything before the hash)
  if (window.location.search) {
    window.history.replaceState(null, '', window.location.pathname + window.location.hash)
  }
  const initialHash = parseHash()
  const [activeTab, setActiveTab] = useState<TabId>(initialHash.tab)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('dcc-theme')
    return (saved === 'dark') ? 'dark' : 'light'
  })
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('dcc-nav-collapsed') === 'true')
  const [team, setTeam] = useState<TeamMember[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [brandOptions, setBrandOptions] = useState<string[]>(defaultBrandOptions)
  const [calendarData, setCalendarData] = useState<CalendarData | null>(null)
  const [capacityData, setCapacityData] = useState<CapacityData | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null)
  const [formData, setFormData] = useState({ name: '', role: '', brands: ["Barron's"] as string[], status: 'offline' as TeamMember['status'], slack: '', email: '', timeOff: [] as { name: string; startDate: string; endDate: string; id: string }[] })
  
  // Project modal state
  const timelineSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const prioritySensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const [showProjectModal, setShowProjectModal] = useState(false)
  const [projectViewMode, setProjectViewMode] = useState<'list' | 'priority'>('list')
  // priorities: { [business_line_id]: project_id[] } in rank order
  const [priorities, setPriorities] = useState<Record<string, string[]>>({})
  const [priorityBusinessLine, setPriorityBusinessLine] = useState<string>('')
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [projectFormData, setProjectFormData] = useState({
    name: '',
    description: '',
    url: '',
    status: 'active' as Project['status'],
    startDate: '',
    endDate: '',
    designers: [] as string[],
    businessLines: [] as string[],
    deckName: '',
    deckLink: '',
    prdName: '',
    prdLink: '',
    briefName: '',
    briefLink: '',
    figmaLink: '',
    customLinks: [] as { name: string; url: string }[],
    timeline: [] as TimelineRange[],
    estimatedHours: 0
  })
  
  const [projectImages, setProjectImages] = useState<ProjectImage[]>([])
  const [allProjectImages, setAllProjectImages] = useState<ProjectImage[]>([])
  const [uploadingImage, setUploadingImage] = useState(false)
  const [lightbox, setLightbox] = useState<{ images: ProjectImage[]; index: number } | null>(null)

  // Reviews state
  const [reviews, setReviews] = useState<{ id: string; title: string; week: string | null; created_by: string | null; created_at: string; updated_at: string; itemCount: number }[]>([])
  const [editingReview, setEditingReview] = useState<any>(null)
  const [showCreateReviewModal, setShowCreateReviewModal] = useState(false)
  const [createReviewForm, setCreateReviewForm] = useState({ title: '', selectedProjectIds: [] as string[] })
  const [reviewCopied, setReviewCopied] = useState(false)
  const [showDeleteReviewModal, setShowDeleteReviewModal] = useState(false)

  // Timeline editing state
  const [showTimelineModal, setShowTimelineModal] = useState(false)
  const [editingTimeline, setEditingTimeline] = useState<TimelineRange | null>(null)
  const [timelineFormData, setTimelineFormData] = useState({ name: '', startDate: '', endDate: '' })

  const [showTimeOffModal, setShowTimeOffModal] = useState(false)
  const [editingTimeOff, setEditingTimeOff] = useState<{ name: string; startDate: string; endDate: string; id: string } | null>(null)
  const [timeOffFormData, setTimeOffFormData] = useState({ name: '', startDate: '', endDate: '' })

  // Holidays state
  const [holidays, setHolidays] = useState<{ id: string; name: string; date: string }[]>([])
  const [holidayForm, setHolidayForm] = useState({ name: '', date: '' })
  const [showHolidayModal, setShowHolidayModal] = useState(false)
  const [riskDetail, setRiskDetail] = useState<{ title: string; items: { name: string; detail: string; projectName?: string }[] } | null>(null)

  // Calendar day modal state
  const [selectedDay, setSelectedDay] = useState<{ date: string; events: CalendarEvent[]; dayName: string } | null>(null)
  // Quick time-off modal (from calendar click)
  const [quickTimeOff, setQuickTimeOff] = useState<{ date: string; member: TeamMember; editEntry: { name: string; startDate: string; endDate: string; id: string } | null; dayEvents: CalendarEvent[]; dayName: string } | null>(null)
  const [quickTimeOffForm, setQuickTimeOffForm] = useState({ name: '', startDate: '', endDate: '' })
  const contentRef = useRef<HTMLDivElement>(null)
  const overlayMouseDownTarget = useRef<EventTarget | null>(null)
  const onDataChangeRef = useRef<() => void>(() => {})
  const pendingRefreshRef = useRef(false)

  const [isLoaded, setIsLoaded] = useState(false)
  const [projectSortBy, setProjectSortBy] = useState<'name' | 'businessLine' | 'designer' | 'dueDate' | 'status'>(() => { try { return (localStorage.getItem('dcc_projectSortBy') as any) || 'businessLine' } catch { return 'businessLine' } })
  const [projectFilters, setProjectFilters] = useState<{businessLines:string[],designers:string[],statuses:string[],project:string|null}>(() => {
  // Hash params take priority over localStorage
  if (initialHash.tab === 'projects' && initialHash.params.toString()) {
    const p = initialHash.params
    return {
      project: p.get('project') || null,
      businessLines: p.getAll('bl'),
      designers: p.getAll('designer'),
      statuses: p.getAll('status')
    }
  }
  try {
    const s = localStorage.getItem('dcc_projectFilters')
    if (s) return JSON.parse(s)
  } catch {}
  return {businessLines:[],designers:[],statuses:[],project:null}
})
  const [calendarFilters, setCalendarFilters] = useState({
    designers: [] as string[],
    projects: [] as string[],
    brands: [] as string[]
  })
  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('dcc-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light')

  const toggleNavCollapsed = () => {
    setNavCollapsed(prev => {
      const next = !prev
      localStorage.setItem('dcc-nav-collapsed', String(next))
      return next
    })
  }

  useEffect(() => {
  try { localStorage.setItem('dcc_projectSortBy', localStorage.getItem('dcc_projectSortBy') || 'name') } catch {}
  try { localStorage.setItem('dcc_projectFilters', JSON.stringify(projectFilters)) } catch {}
}, [projectFilters])

const [showFilters, setShowFilters] = useState(false)
  const [assignmentForm, setAssignmentForm] = useState({ project_id: '', designer_id: '', allocation_hours: 0 })
  const [hoursDraft, setHoursDraft] = useState<Record<string, number>>({})
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, number>>({})
  const [excludedDesigners, setExcludedDesigners] = useState<Set<string>>(new Set())
  const [capacityDesignerFilter, setCapacityDesignerFilter] = useState<Set<string>>(() => {
    if (initialHash.tab === 'capacity' && initialHash.params.has('designer')) {
      return new Set(initialHash.params.getAll('designer'))
    }
    try { const s = localStorage.getItem('dcc_capacityDesignerFilter'); return s ? new Set(JSON.parse(s)) : new Set() } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('dcc_capacityDesignerFilter', JSON.stringify([...capacityDesignerFilter])) } catch {}
  }, [capacityDesignerFilter])
  const [showCapacityHelp, setShowCapacityHelp] = useState(false)

  // Deep linking: sync URL hash with tab + filters
  const hashUpdateRef = useRef(false)
  useEffect(() => {
    const params = new URLSearchParams()
    if (activeTab === 'projects') {
      if (projectFilters.project) params.set('project', projectFilters.project)
      projectFilters.businessLines.forEach(bl => params.append('bl', bl))
      projectFilters.designers.forEach(d => params.append('designer', d))
      projectFilters.statuses.forEach(s => params.append('status', s))
    } else if (activeTab === 'capacity' && capacityDesignerFilter.size > 0) {
      capacityDesignerFilter.forEach(id => params.append('designer', id))
    }
    const qs = params.toString()
    const newHash = `#/${activeTab}${qs ? '?' + qs : ''}`
    if (window.location.hash !== newHash) {
      hashUpdateRef.current = true
      window.history.replaceState(null, '', newHash)
    }
  }, [activeTab, projectFilters, capacityDesignerFilter])

  // Handle browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      if (hashUpdateRef.current) { hashUpdateRef.current = false; return }
      const { tab, params } = parseHash()
      setActiveTab(tab)
      if (tab === 'projects' && params.toString()) {
        setProjectFilters({
          project: params.get('project') || null,
          businessLines: params.getAll('bl'),
          designers: params.getAll('designer'),
          statuses: params.getAll('status')
        })
      }
      if (tab === 'capacity' && params.has('designer')) {
        setCapacityDesignerFilter(new Set(params.getAll('designer')))
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const [confirmModal, setConfirmModal] = useState<{ open: boolean; title: string; message: string; onConfirm: (() => Promise<void> | void) | null; confirmLabel?: string; danger?: boolean }>({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })

  // Filter helpers for calendar
  const filterCalendarEvents = (events: CalendarEvent[]) => {
    // If no filters selected, show all events
    if (calendarFilters.designers.length === 0 && calendarFilters.projects.length === 0 && calendarFilters.brands.length === 0) {
      return events
    }
    return events.filter(event => {
      // Holidays always show regardless of filters
      if (event.type === 'holiday') return true
      // Designer filter - shows ONLY time off (not projects)
      if (calendarFilters.designers.length > 0 && event.type === 'timeoff' && event.person) {
        const matchesPerson = calendarFilters.designers.includes(event.person)
        if (matchesPerson) return true
      }
      // Project filter - shows ONLY projects
      if (calendarFilters.projects.length > 0 && event.type === 'project' && event.projectName) {
        if (calendarFilters.projects.includes(event.projectName)) {
          return true
        }
      }
      // Brand filter - shows ONLY projects
      if (calendarFilters.brands.length > 0 && event.type === 'project') {
        const proj = projects.find(p => p.name === event.projectName)
        if (proj && proj.businessLines && proj.businessLines.length > 0) {
          if (proj.businessLines.some((bl: string) => calendarFilters.brands.includes(bl))) {
            return true
          }
        }
      }
      return false
    })
  }

  // Toggle all helpers
  const toggleAllDesigners = () => {
    if (calendarFilters.designers.length === team.length) {
      setCalendarFilters({...calendarFilters, designers: []})
    } else {
      setCalendarFilters({...calendarFilters, designers: team.map(m => m.name)})
    }
  }

  const toggleAllProjects = () => {
    if (calendarFilters.projects.length === projects.length) {
      setCalendarFilters({...calendarFilters, projects: []})
    } else {
      setCalendarFilters({...calendarFilters, projects: projects.map(p => p.name)})
    }
  }

  const toggleAllBrands = () => {
    if (calendarFilters.brands.length === brandOptions.length) {
      setCalendarFilters({...calendarFilters, brands: []})
    } else {
      setCalendarFilters({...calendarFilters, brands: [...brandOptions]})
    }
  }

  // Version tracking
  const [siteVersion, setSiteVersion] = useState({ version: '', time: '' })
  const [dbVersion, setDbVersion] = useState({ version: '', time: '' })

  // Search
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ projects: Project[], team: TeamMember[], businessLines: BusinessLine[], notes: Note[] }>({ projects: [], team: [], businessLines: [], notes: [] })
  const [searchFilters] = useState<{ projects: boolean, team: boolean, businessLines: boolean }>({ projects: true, team: true, businessLines: true })
  const [searchLoading, setSearchLoading] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Authentication
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ id: number; email: string; role: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loginError, setLoginError] = useState('')
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  
  // User management (admin only)
  const [users, setUsers] = useState<{ id: number; email: string; role: string; created_at: string }[]>([])
  const [showUserModal, setShowUserModal] = useState(false)
  const [userFormData, setUserFormData] = useState({ email: '', password: '', role: 'user' })

  // Notifications
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [lastSeenActivity, setLastSeenActivity] = useState<string>(() => localStorage.getItem('dcc-last-seen-activity') || '')
  const notifRef = useRef<HTMLDivElement>(null)

  // Get session ID from localStorage
  const getSessionId = () => localStorage.getItem('dcc-session-id')
  const setSessionId = (id: string) => {
    localStorage.setItem('dcc-session-id', id)
  }
  const clearSessionId = () => {
    localStorage.removeItem('dcc-session-id')
  }

  // Clear recovery flag on successful mount
  useEffect(() => { sessionStorage.removeItem('dcc-recovery') }, [])

  // Check auth on mount
  useEffect(() => {
    const checkAuth = async () => {
      const sessionId = getSessionId()
      if (!sessionId) {
        setIsLoading(false)
        return
      }
      try {
        const res = await fetch('/api/auth/me', {
          headers: { 'x-session-id': sessionId }
        })
        if (res.ok) {
          const user = await res.json()
          setCurrentUser(user)
          setIsAuthenticated(true)
          setActiveTab('projects')
        } else {
          // Stale session (server restarted) — clear so login page shows cleanly
          clearSessionId()
        }
      } catch (err) {
        console.error('Auth check failed:', err)
        clearSessionId()
      }
      setIsLoading(false)
    }
    checkAuth()
  }, [])

  // Redirect to default tab when authenticated
  useEffect(() => {
    if (isAuthenticated && !activeTab) {
      setActiveTab('projects')
    }
  }, [isAuthenticated])

  // Fetch activity log for notifications
  const fetchActivity = async () => {
    try {
      const res = await authFetch('/api/activity?limit=100')
      if (res.ok) {
        const data = await res.json()
        setActivityItems(data)
      }
    } catch (e) { /* silent */ }
  }

  useEffect(() => {
    if (!isAuthenticated) return
    fetchActivity()
    const interval = setInterval(fetchActivity, 60000) // poll every 60s
    return () => clearInterval(interval)
  }, [isAuthenticated])

  // Close notification panel on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (showNotifications && notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showNotifications])

  const hasUnseenActivity = activityItems.length > 0 && (!lastSeenActivity || activityItems[0].created_at > lastSeenActivity)

  const openNotifications = () => {
    setShowNotifications(prev => !prev)
    if (!showNotifications && activityItems.length > 0) {
      const latest = activityItems[0].created_at
      setLastSeenActivity(latest)
      localStorage.setItem('dcc-last-seen-activity', latest)
    }
  }

  // Handle login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm)
      })
      if (!res.ok) {
        const err = await res.json()
        setLoginError(err.error || 'Login failed')
        return
      }
      const data = await res.json()
      setSessionId(data.sessionId)
      setCurrentUser(data.user)
      setIsAuthenticated(true)
      setActiveTab('projects')
      // Delay reload so browser can capture credentials and offer "Save password?"
      setTimeout(() => window.location.reload(), 100)
    } catch (err) {
      setLoginError('Login failed. Please try again.')
    }
  }

  // Handle logout
  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-session-id': getSessionId() || '' }
      })
    } catch (err) {
      console.error('Logout error:', err)
    }
    clearSessionId()
    setCurrentUser(null)
    setIsAuthenticated(false)
  }

  // Fetch users (admin only)
  const fetchUsers = async () => {
    try {
      const res = await authFetch('/api/users')
      if (res.ok) {
        const data = await res.json()
        setUsers(data)
      }
    } catch (err) {
      console.error('Error fetching users:', err)
    }
  }

  // Fetch users when settings tab opens (admin only)
  useEffect(() => {
    if (activeTab === 'settings' && currentUser?.role === 'admin') {
      fetchUsers()
    }
  }, [activeTab, currentUser])

  // Create user
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await authFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ ...userFormData, password: 'dj_wandihub!' })
      })
      if (res.ok) {
        setShowUserModal(false)
        setUserFormData({ email: '', password: '', role: 'user' })
        fetchUsers()
      } else {
        const err = await res.json()
        alert(err.error || 'Failed to create user')
      }
    } catch (err) {
      alert('Failed to create user')
    }
  }

  // Delete user
  const handleDeleteUser = (userId: number) => {
    openConfirmModal('Delete user?', 'This will permanently remove this user account.', async () => {
      try {
        const res = await authFetch(`/api/users/${userId}`, {
          method: 'DELETE',
        })
        if (res.ok) {
          fetchUsers()
        } else {
          const err = await res.json()
          alert(err.error || 'Failed to delete user')
        }
      } catch (err) {
        alert('Failed to delete user')
      }
      closeConfirmModal()
    })
  }

  const isAdmin = currentUser?.role === 'admin'

  // Business Lines (Settings)
  const [businessLines, setBusinessLines] = useState<BusinessLine[]>([])
  const [showBusinessLineModal, setShowBusinessLineModal] = useState(false)
  const [editingBusinessLine, setEditingBusinessLine] = useState<BusinessLine | null>(null)
  const [businessLineFormData, setBusinessLineFormData] = useState({
    name: '', customLinks: [] as { name: string; url: string }[]
  })
  const [blImages, setBlImages] = useState<ProjectImage[]>([])
  const [uploadingBlImage, setUploadingBlImage] = useState(false)
  
  // Notes state
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedNote, setSelectedNote] = useState<Note | null>(null)
  const [noteDetailOpen, setNoteDetailOpen] = useState(false)
  const [editingNote, setEditingNote] = useState<Note | null>(null) // note being edited in modal
  // Hidden notes state for Settings
  const [hiddenNotes, setHiddenNotes] = useState<Note[]>([])
  const [hiddenNotesUnlocked, setHiddenNotesUnlocked] = useState(false)
  const [hiddenNotesPin, setHiddenNotesPin] = useState('')
  const [showHiddenNotesPinModal, setShowHiddenNotesPinModal] = useState(false)
  // PIN modal for hiding notes
  const [showHideNotePinModal, setShowHideNotePinModal] = useState(false)
  const [hideNotePin, setHideNotePin] = useState('')
  const [noteToHide, setNoteToHide] = useState<Note | null>(null)

  // Maintenance mode state
  const [maintenance, setMaintenance] = useState<{
    enabled: boolean
    bannerMessage: string
    lockoutMessage: string
    countdownTarget: string | null
    isLockout: boolean
  }>({ enabled: false, bannerMessage: '', lockoutMessage: '', countdownTarget: null, isLockout: false })
  const [maintenanceForm, setMaintenanceForm] = useState({ bannerMessage: 'Save your work. Wandi Hub maintenance about to begin in 5 minutes.', lockoutMessage: 'Wandi Hub will be back soon.', countdownMinutes: 5 })
  const [countdownDisplay, setCountdownDisplay] = useState('')
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [showChangelog, setShowChangelog] = useState(true)
  const [copiedReport, setCopiedReport] = useState<number | null>(null)
  const [reportModal, setReportModal] = useState<{ open: boolean; title: string; content: string; richContent?: React.ReactNode }>({ open: false, title: '', content: '' })
  const [showArchive, setShowArchive] = useState(false)
  const [showSnapshotHistory, setShowSnapshotHistory] = useState(false)
  const [showWeeklyPending, setShowWeeklyPending] = useState(false)
  const [openCritsSyncing, setOpenCritsSyncing] = useState(false)
  const [weeklyUpdates, setWeeklyUpdates] = useState<WeeklyUpdate[]>([])
  const [weeklyGeneral, setWeeklyGeneral] = useState<WeeklyGeneral[]>([])
  const [currentWeek, setCurrentWeek] = useState('')
  const [weeklyExpandedProject, setWeeklyExpandedProject] = useState<string | null>(null)
  const [weeklySnapshots, setWeeklySnapshots] = useState<{ id: string; week: string; generated_at: string }[]>([])
  const [reviewSnapshots, setReviewSnapshots] = useState<{ id: string; week: string; generated_at: string }[]>([])
  const [showReviewSnapshotHistory, setShowReviewSnapshotHistory] = useState(false)
  const [missingUpdates, setMissingUpdates] = useState<{ id: string; name: string }[]>([])
  
  // Server-Sent Events — live updates from server
  useEffect(() => {
    const baseUrl = import.meta.env.DEV ? 'http://localhost:3001' : ''
    const es = new EventSource(`${baseUrl}/api/events`)

    es.addEventListener('maintenance', (e) => {
      try { setMaintenance(JSON.parse(e.data)) } catch {}
    })

    es.addEventListener('version', (e) => {
      try {
        const { site_version } = JSON.parse(e.data)
        // Set client version on first connect (before state is populated)
        if (!getClientVersion()) setClientVersion(site_version)
        setSiteVersion(prev => {
          // If we already have a version and the server sent a different one, show update banner
          if (prev.version && site_version && prev.version !== site_version) {
            setUpdateAvailable(true)
          }
          return prev
        })
      } catch {}
    })

    es.addEventListener('data-change', () => {
      onDataChangeRef.current()
    })

    es.addEventListener('reload', () => {
      // Full DB replacement — refresh all data without losing session
      onDataChangeRef.current()
    })

    return () => es.close()
  }, [])

  // Countdown timer — updates every second when countdown is active
  useEffect(() => {
    if (!maintenance.enabled || !maintenance.countdownTarget) {
      setCountdownDisplay('')
      return
    }
    const tick = () => {
      const remaining = new Date(maintenance.countdownTarget!).getTime() - Date.now()
      if (remaining <= 0) {
        setCountdownDisplay('0:00')
        // SSE will push the lockout state, but fetch as fallback
        fetch('/api/maintenance').then(r => r.json()).then(data => setMaintenance(data)).catch(() => {})
        return
      }
      const mins = Math.floor(remaining / 60000)
      const secs = Math.floor((remaining % 60000) / 1000)
      setCountdownDisplay(`${mins}:${secs.toString().padStart(2, '0')}`)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [maintenance.enabled, maintenance.countdownTarget])

  // Load versions from server on mount
  useEffect(() => {
    const loadVersions = async () => {
      try {
        const res = await authFetch('/api/versions')
        const data = await res.json()
        setClientVersion(data.site_version || '')
        setSiteVersion({ version: data.site_version || '', time: data.site_time || '' })
        setDbVersion({ version: data.db_version || '', time: data.db_time || '' })
      } catch (e) {
        console.error('Failed to load versions:', e)
      }
    }
    loadVersions()
  }, [])

  // Load initial data from API
  useEffect(() => {
    const init = async () => {
      try {
        const data = await loadDataFromAPI()
        if (data) {
          setTeam(data.team || [])
          setProjects(data.projects || [])
          if (data.brandOptions) {
            setBrandOptions(data.brandOptions.sort())
          }
        }
        // Load business lines
        const blRes = await authFetch('/api/business-lines')
        const blData = await blRes.json()
        setBusinessLines(blData)
        // Load all project images
        authFetch('/api/images').then(r => r.json()).then(setAllProjectImages).catch(() => {})
        // Load priorities
        const prRes = await authFetch('/api/priorities')
        const prData: { business_line_id: string; project_id: string; rank: number }[] = await prRes.json()
        const prMap: Record<string, string[]> = {}
        for (const row of prData) {
          if (!prMap[row.business_line_id]) prMap[row.business_line_id] = []
          prMap[row.business_line_id].push(row.project_id)
        }
        setPriorities(prMap)
      } catch (err) {
        console.error('Error loading data:', err)
      } finally {
        setIsLoaded(true)
      }
    }
    init()
  }, [])

  // Initialize calendar filters with all designers selected once team data is loaded
  useEffect(() => {
    if (team.length > 0 && calendarFilters.designers.length === 0) {
      setCalendarFilters(prev => ({...prev, designers: team.map(m => m.name)}))
    }
  }, [team])

  // Load calendar data when switching to calendar tab
  useEffect(() => {
    if (activeTab === 'calendar' && !calendarData) {
      const loadCalendar = async () => {
        try {
          const response = await authFetch('/api/calendar')
          const data = await response.json()
          setCalendarData(data)
        } catch (err) {
          console.error('Error loading calendar:', err)
        }
      }
      loadCalendar()
    }
  }, [activeTab, calendarData])

  // Load holidays
  useEffect(() => {
    const loadHolidays = async () => {
      try {
        const res = await authFetch('/api/holidays')
        const data = await res.json()
        if (Array.isArray(data)) {
          if (data.length === 0) {
            // Seed default holidays on first load
            for (const h of defaultHolidays) {
              await authFetch('/api/holidays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(h) })
            }
            const res2 = await authFetch('/api/holidays')
            setHolidays(await res2.json())
          } else {
            setHolidays(data)
          }
        }
      } catch (err) { console.error('Error loading holidays:', err) }
    }
    if (currentUser) loadHolidays()
  }, [currentUser])

  // Load weekly updates for current week
  useEffect(() => {
    if (!currentUser) return
    const loadWeekly = async () => {
      try {
        const weekRes = await authFetch('/api/current-week')
        const { week } = await weekRes.json()
        setCurrentWeek(week)
        const [updatesRes, generalRes, snapshotsRes, missingRes, reviewSnapshotsRes] = await Promise.all([
          authFetch(`/api/weekly-updates?week=${week}`),
          authFetch(`/api/weekly-general?week=${week}`),
          authFetch('/api/weekly-snapshots'),
          authFetch(`/api/weekly-updates/missing?week=${week}`),
          authFetch('/api/review-snapshots'),
        ])
        setWeeklyUpdates(await updatesRes.json())
        setWeeklyGeneral(await generalRes.json())
        setWeeklySnapshots(await snapshotsRes.json())
        setReviewSnapshots(await reviewSnapshotsRes.json())
        const missingData = await missingRes.json()
        setMissingUpdates(missingData.projects || [])
      } catch (err) { console.error('Error loading weekly data:', err) }
    }
    loadWeekly()
  }, [currentUser])

  const saveWeeklyUpdate = async (update: Partial<WeeklyUpdate>) => {
    try {
      const res = await authFetch('/api/weekly-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update)
      })
      const saved = await res.json() as WeeklyUpdate
      setWeeklyUpdates(prev => {
        const idx = prev.findIndex(u => u.id === saved.id)
        return idx >= 0 ? prev.map(u => u.id === saved.id ? saved : u) : [...prev, saved]
      })
      return saved
    } catch (err) { console.error('Error saving weekly update:', err); return null }
  }

  const deleteWeeklyUpdate = async (id: string) => {
    await authFetch(`/api/weekly-updates/${id}`, { method: 'DELETE' })
    setWeeklyUpdates(prev => prev.filter(u => u.id !== id))
  }

  const saveWeeklyGeneral = async (entry: Partial<WeeklyGeneral>) => {
    try {
      const res = await authFetch('/api/weekly-general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      })
      const saved = await res.json() as WeeklyGeneral
      setWeeklyGeneral(prev => {
        const idx = prev.findIndex(e => e.id === saved.id)
        return idx >= 0 ? prev.map(e => e.id === saved.id ? saved : e) : [...prev, saved]
      })
      return saved
    } catch (err) { console.error('Error saving weekly general:', err); return null }
  }

  const deleteWeeklyGeneral = async (id: string) => {
    await authFetch(`/api/weekly-general/${id}`, { method: 'DELETE' })
    setWeeklyGeneral(prev => prev.filter(e => e.id !== id))
  }

  // Reset scroll position when switching tabs (non-calendar tabs should start at top)
  useEffect(() => {
    if (activeTab !== 'calendar' && contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }, [activeTab])

  // Auto-scroll to today's month when arriving at calendar view
  useEffect(() => {
    if (activeTab === 'calendar' && calendarData) {
      const today = new Date()
      const todayMonth = today.getMonth() + 1
      const todayYear = today.getFullYear()
      // Wait a tick for DOM to render
      requestAnimationFrame(() => {
        const el = contentRef.current?.querySelector(`[data-month="${todayYear}-${todayMonth}"]`) as HTMLElement | null
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    }
  }, [activeTab, calendarData])

  // Load capacity data when capacity tab is active
  useEffect(() => {
    if (activeTab === 'capacity') {
      const loadCapacity = async () => {
        try {
          const res = await authFetch('/api/capacity')
          const data = await res.json()
          setCapacityData(data)
          const initialHours = (data.team || []).reduce((acc: Record<string, number>, m: CapacityMember) => {
            acc[m.id] = m.weekly_hours || 35
            return acc
          }, {})
          setHoursDraft(initialHours)
          // Load excluded designers from team data
          const initialExcluded = new Set<string>()
          ;(data.team || []).forEach((m: CapacityMember) => {
            if (m.excluded) initialExcluded.add(m.id)
          })
          setExcludedDesigners(initialExcluded)
        } catch (err) {
          console.error('Error loading capacity:', err)
        }
      }
      loadCapacity()
    }
  }, [activeTab])

  // Load reviews when reviews tab is active
  const loadReviews = async (selectId?: string) => {
    try {
      const res = await authFetch('/api/reviews')
      const data = await res.json()
      setReviews(data)
      // Auto-select: specified id, or current, or most recent
      const targetId = selectId || editingReview?.id || data[0]?.id
      if (targetId && data.some((r: any) => r.id === targetId)) {
        loadReviewDetail(targetId)
      } else if (data.length > 0) {
        loadReviewDetail(data[0].id)
      } else {
        setEditingReview(null)
      }
    } catch (err) { console.error('Error loading reviews:', err) }
  }
  useEffect(() => {
    if (activeTab === 'reviews') loadReviews()
  }, [activeTab])

  const loadReviewDetail = async (id: string) => {
    try {
      const res = await authFetch(`/api/reviews/${id}`)
      const data = await res.json()
      setEditingReview(data)
    } catch (err) { console.error('Error loading review:', err) }
  }

  // Notes are loaded on-demand by settings/hidden-notes, not on tab switch

  // Refresh calendar data when projects or team change
  const refreshCalendar = async () => {
    if (calendarData) {
      try {
        const response = await authFetch('/api/calendar')
        const data = await response.json()
        setCalendarData(data)
      } catch (err) {
        console.error('Error refreshing calendar:', err)
      }
    }
  }

  const refreshCapacity = async () => {
    try {
      const res = await authFetch('/api/capacity')
      const data = await res.json()
      setCapacityData(data)
      const initialHours = (data.team || []).reduce((acc: Record<string, number>, m: CapacityMember) => {
        acc[m.id] = m.weekly_hours || 35
        return acc
      }, {})
      setHoursDraft(initialHours)
      const initialExcluded = new Set<string>((data.team || []).filter((m: CapacityMember) => m.excluded).map((m: CapacityMember) => m.id))
      setExcludedDesigners(initialExcluded)
    } catch (err) {
      console.error('Error refreshing capacity:', err)
    }
  }

  const saveCapacityAssignment = async () => {
    if (!assignmentForm.project_id || !assignmentForm.designer_id) {
      alert('Select both a project and a designer')
      return
    }
    const designer = capacityData?.team.find(m => m.id === assignmentForm.designer_id)
    const weeklyHours = designer?.weekly_hours || 35
    const allocationPercent = Math.round((assignmentForm.allocation_hours / weeklyHours) * 100)
    await authFetch('/api/capacity/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: assignmentForm.project_id,
        designer_id: assignmentForm.designer_id,
        allocation_percent: allocationPercent,
      })
    })
    await refreshCapacity()
  }

  const saveAssignmentAllocation = async (assignment: CapacityAssignment, allocationPercent: number) => {
    await authFetch('/api/capacity/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: assignment.project_id,
        designer_id: assignment.designer_id,
        allocation_percent: allocationPercent,
      })
    })
    await refreshCapacity()
  }

  const removeCapacityAssignment = async (id: string) => {
    await authFetch(`/api/capacity/assignments/${id}`, { method: 'DELETE' })
    await refreshCapacity()
  }

  const openConfirmModal = (title: string, message: string, onConfirm: () => Promise<void> | void, opts?: { confirmLabel?: string; danger?: boolean }) => {
    setConfirmModal({ open: true, title, message, onConfirm, confirmLabel: opts?.confirmLabel, danger: opts?.danger ?? true })
  }

  const closeConfirmModal = () => {
    setConfirmModal({ open: false, title: '', message: '', onConfirm: null })
  }

  const updateWeeklyHours = async (designerId: string, weeklyHours: number) => {
    await authFetch(`/api/capacity/availability/${designerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekly_hours: weeklyHours })
    })
    await refreshCapacity()
  }

  const updateExcludedStatus = async (designerId: string, excluded: boolean) => {
    await authFetch(`/api/capacity/availability/${designerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded })
    })
    await refreshCapacity()
  }

  // API helper functions
  const saveTeamMember = async (member: TeamMember): Promise<boolean> => {
    const res = await authFetch('/api/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(member)
    })
    if (res.status === 409) {
      alert('This team member was modified by another user. The page will refresh with the latest data.')
      window.location.reload()
      return false
    }
    return res.ok
  }

  const deleteTeamMember = async (id: string) => {
    await authFetch(`/api/team/${id}`, { method: 'DELETE' })
  }

  const saveProject = async (project: Project): Promise<boolean> => {
    try {
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project)
      })
      if (res.status === 409) {
        alert('This project was modified by another user. The page will refresh with the latest data.')
        window.location.reload()
        return false
      }
      if (!res.ok) {
        const err = await res.text()
        console.error('Save project failed:', res.status, err)
        alert(`Failed to save project: ${res.status} ${err}`)
        return false
      }
      return true
    } catch (err) {
      console.error('Save project error:', err)
      alert(`Network error saving project: ${err}`)
      return false
    }
  }

  const deleteProject = async (id: string) => {
    await authFetch(`/api/projects/${id}`, { method: 'DELETE' })
  }

// Search
  const handleSearch = (query: string) => {
    setSearchQuery(query)
    
    // Clear any pending debounce timer
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }
    
    if (query.trim().length < 2) {
      setSearchResults({ projects: [], team: [], businessLines: [], notes: [] })
      return
    }
    
    // Debounce the API call - wait 300ms after last keystroke
    setSearchLoading(true)
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams()
        params.set('q', query)
        if (!searchFilters.projects) params.set('projects', 'false')
        if (!searchFilters.team) params.set('team', 'false')
        if (!searchFilters.businessLines) params.set('businessLines', 'false')
        const res = await authFetch(`/api/search?${params.toString()}`)
        const data = await res.json()
        setSearchResults(data)
      } catch (e) {
        console.error('Search error:', e)
      } finally {
        setSearchLoading(false)
      }
    }, 300)
  }

  const filteredResults = {
    projects: searchResults.projects,
    team: searchResults.team,
    businessLines: searchResults.businessLines,
    notes: searchResults.notes || []
  }

  // Re-search when filters change (to update backend query) - immediate, not debounced
  const searchQueryRef = useRef(searchQuery)
  searchQueryRef.current = searchQuery
  useEffect(() => {
    const q = searchQueryRef.current
    if (q.length >= 2) {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }
      ;(async () => {
        try {
          const params = new URLSearchParams()
          params.set('q', q)
          if (!searchFilters.projects) params.set('projects', 'false')
          if (!searchFilters.team) params.set('team', 'false')
          if (!searchFilters.businessLines) params.set('businessLines', 'false')
          const res = await authFetch(`/api/search?${params.toString()}`)
          const data = await res.json()
          setSearchResults(data)
        } catch (e) {
          console.error('Search error:', e)
        }
      })()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFilters.projects, searchFilters.team, searchFilters.businessLines])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }
    }
  }, [])

  // Keyboard shortcut: Cmd/Ctrl+K to open search, Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch(prev => !prev)
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false)
        setSearchQuery('')
        setSearchResults({ projects: [], team: [], businessLines: [], notes: [] })
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showSearch])

  // Business Line CRUD
  const saveBusinessLine = async (line: BusinessLine, originalName?: string) => {
    const saveRes = await authFetch('/api/business-lines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...line, originalName })
    })
    if (saveRes.status === 409) {
      alert('This business line was modified by another user. The page will refresh with the latest data.')
      window.location.reload()
      return
    }
    // Refresh business lines
    const res = await authFetch('/api/business-lines')
    const data = await res.json()
    setBusinessLines(data)
    // Also refresh team and projects to reflect name changes
    const dataRes = await  authFetch('/api/data')
    const apiData = await dataRes.json()
    setTeam(apiData.team || [])
    setProjects(apiData.projects || [])
  }

  // Persist sort/filter to localStorage
  useEffect(() => { try { localStorage.setItem('dcc_projectSortBy', projectSortBy) } catch {} }, [projectSortBy])
  useEffect(() => { try { localStorage.setItem('dcc_projectFilters', JSON.stringify(projectFilters)) } catch {} }, [projectFilters])

  // Refresh projects list from server
  const refreshProjects = async () => {
    try {
      const res = await authFetch('/api/projects')
      const data = await res.json()
      setProjects(data)
    } catch (err) {
      console.error('Error refreshing projects:', err)
    }
  }

  // Keep SSE data-change handler current with latest refresh functions
  useEffect(() => {
    onDataChangeRef.current = () => {
      if (showProjectModal || showTimelineModal || showTimeOffModal || showModal) {
        pendingRefreshRef.current = true
        return
      }
      fetchActivity()
      refreshProjects()
      refreshCalendar()
      refreshCapacity()
    }
  })

  // Flush pending SSE refresh when all editing modals close
  useEffect(() => {
    if (!showProjectModal && !showTimelineModal && !showTimeOffModal && !showModal && pendingRefreshRef.current) {
      pendingRefreshRef.current = false
      fetchActivity()
      refreshProjects()
      refreshCalendar()
      refreshCapacity()
    }
  }, [showProjectModal, showTimelineModal, showTimeOffModal, showModal])

  const deleteBusinessLine = async (id: string) => {
    await authFetch(`/api/business-lines/${id}`, { method: 'DELETE' })
    setBusinessLines(businessLines.filter(bl => bl.id !== id))
  }

  const uploadBlImage = async (blId: string, file: Blob, originalName: string) => {
    setUploadingBlImage(true)
    try {
      const res = await authFetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png', 'X-Project-Id': blId, 'X-Original-Name': originalName },
        body: file,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        alert(`Image upload failed: ${err.error || res.statusText}`)
        setUploadingBlImage(false)
        return
      }
      const saved = await res.json() as ProjectImage
      setBlImages(prev => [saved, ...prev])
      setAllProjectImages(prev => [saved, ...prev])
    } catch (err) { console.error('BL image upload error:', err) }
    setUploadingBlImage(false)
  }

  const deleteBlImage = async (imageId: string) => {
    try {
      await authFetch(`/api/images/${imageId}`, { method: 'DELETE' })
      setBlImages(prev => prev.filter(img => img.id !== imageId))
      setAllProjectImages(prev => prev.filter(img => img.id !== imageId))
    } catch (err) { console.error('BL image delete error:', err) }
  }

  const updateBlImageCaption = async (imageId: string, caption: string) => {
    try {
      const res = await authFetch(`/api/images/${imageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption }),
      })
      const saved = await res.json() as ProjectImage
      setBlImages(prev => prev.map(img => img.id === imageId ? saved : img))
      setAllProjectImages(prev => prev.map(img => img.id === imageId ? saved : img))
    } catch (err) { console.error('BL caption update error:', err) }
  }

  // Handle clicking a project event in day modal - switch to projects page
  const handleEventClick = (event: CalendarEvent) => {
    if (event.type === 'project' && event.projectName) {
      setSelectedDay(null)
      setProjectFilters({ businessLines: [], designers: [], statuses: [], project: event.projectName || null })
      setProjectSortBy('name')
      setActiveTab('projects')
    }
  }

  const handleAddProject = () => {
    setEditingProject(null)
    setProjectFormData({
      name: '', description: '', url: '', status: 'active', startDate: '', endDate: '', designers: [],
      businessLines: [],
      deckName: '', deckLink: '', prdName: '', prdLink: '', briefName: '', briefLink: '', figmaLink: '',
      customLinks: [],
      timeline: [],
      estimatedHours: 0
    })
    setShowProjectModal(true)
    setProjectImages([])
  }

  const handleEditProject = (project: Project) => {
    setEditingProject(project)
    setProjectFormData({
      name: project.name,
      description: project.description || '',
      url: project.url || '',
      status: project.status,
      startDate: project.startDate || '',
      endDate: project.endDate || '',
      designers: project.designers || [],
      businessLines: project.businessLines || [],
      deckName: project.deckName || '',
      deckLink: project.deckLink || '',
      prdName: project.prdName || '',
      prdLink: project.prdLink || '',
      briefName: project.briefName || '',
      briefLink: project.briefLink || '',
      figmaLink: project.figmaLink || '',
      customLinks: project.customLinks || [],
      timeline: project.timeline || [],
      estimatedHours: project.estimatedHours || 0
    })
    setShowProjectModal(true)
    // Load images for this project
    authFetch(`/api/images?project_id=${project.id}`).then(r => r.json()).then(setProjectImages).catch(() => setProjectImages([]))
  }

  const uploadProjectImage = async (projectId: string, file: Blob, originalName: string) => {
    setUploadingImage(true)
    try {
      const res = await authFetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png', 'X-Project-Id': projectId, 'X-Original-Name': originalName },
        body: file,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        alert(`Image upload failed: ${err.error || res.statusText}`)
        setUploadingImage(false)
        return
      }
      const saved = await res.json() as ProjectImage
      setProjectImages(prev => [...prev, saved])
      setAllProjectImages(prev => [...prev, saved])
    } catch (err) { console.error('Image upload error:', err) }
    setUploadingImage(false)
  }

  const deleteProjectImage = async (imageId: string) => {
    try {
      await authFetch(`/api/images/${imageId}`, { method: 'DELETE' })
      setProjectImages(prev => prev.filter(img => img.id !== imageId))
      setAllProjectImages(prev => prev.filter(img => img.id !== imageId))
    } catch (err) { console.error('Image delete error:', err) }
  }

  const updateImageCaption = async (imageId: string, caption: string) => {
    try {
      const res = await authFetch(`/api/images/${imageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption }),
      })
      const saved = await res.json() as ProjectImage
      setProjectImages(prev => prev.map(img => img.id === imageId ? saved : img))
      setAllProjectImages(prev => prev.map(img => img.id === imageId ? saved : img))
    } catch (err) { console.error('Caption update error:', err) }
  }

  const reorderProjectImages = async (projectId: string, reordered: ProjectImage[]) => {
    setProjectImages(reordered)
    setAllProjectImages(prev => {
      const other = prev.filter(img => img.project_id !== projectId)
      return [...other, ...reordered]
    })
    try {
      await authFetch(`/api/images/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, image_ids: reordered.map(i => i.id) }),
      })
    } catch (err) { console.error('Image reorder error:', err) }
  }

  const handleDeleteProject = async (id: string) => {
    openConfirmModal('Delete project?', 'This will permanently remove the project and related capacity assignments.', async () => {
      try {
        await deleteProject(id)
        setProjects(projects.filter(p => p.id !== id))
        
      } catch (err) {
        console.error('Delete failed:', err)
        alert('Failed to delete project')
      } finally {
        closeConfirmModal()
      }
    })
  }

  // Timeline management
  const handleAddTimeline = () => {
    setEditingTimeline(null)
    setTimelineFormData({ name: '', startDate: '', endDate: '' })
    setShowTimelineModal(true)
  }

  const handleEditTimeline = (range: TimelineRange) => {
    setEditingTimeline(range)
    setTimelineFormData({ name: range.name, startDate: range.startDate, endDate: range.endDate })
    setShowTimelineModal(true)
  }

  const handleDeleteTimeline = (id: string) => {
    openConfirmModal('Delete timeline range?', 'This will remove the timeline range from this project.', () => {
      setProjectFormData(prev => ({
        ...prev,
        timeline: prev.timeline.filter(t => t.id !== id)
      }))
      closeConfirmModal()
    })
  }

  const handleTimelineDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = projectFormData.timeline.findIndex(t => t.id === active.id)
    const newIndex = projectFormData.timeline.findIndex(t => t.id === over.id)
    setProjectFormData({ ...projectFormData, timeline: arrayMove(projectFormData.timeline, oldIndex, newIndex) })
  }

  const handleSaveTimeline = () => {
    if (!timelineFormData.name.trim()) {
      alert('Please enter a timeline name')
      return
    }
    if (!timelineFormData.startDate || !timelineFormData.endDate) {
      alert('Please select start and end dates')
      return
    }
    const tlStart = parseLocalDate(timelineFormData.startDate)
    const tlEnd = parseLocalDate(timelineFormData.endDate)
    if (tlStart && tlEnd && tlEnd < tlStart) {
      alert('End date must be after start date')
      return
    }

    if (editingTimeline) {
      setProjectFormData({
        ...projectFormData,
        timeline: projectFormData.timeline.map(t => 
          t.id === editingTimeline.id 
            ? { ...t, ...timelineFormData }
            : t
        )
      })
    } else {
      setProjectFormData({
        ...projectFormData,
        timeline: [...projectFormData.timeline, { ...timelineFormData, id: Date.now().toString() }]
      })
    }
    setShowTimelineModal(false)
  }

  const handleAddTimeOff = () => {
    setEditingTimeOff(null)
    setTimeOffFormData({ name: '', startDate: '', endDate: '' })
    setShowTimeOffModal(true)
  }

  const handleEditTimeOff = (off: { name: string; startDate: string; endDate: string; id: string }) => {
    setEditingTimeOff(off)
    setTimeOffFormData({ name: off.name, startDate: off.startDate, endDate: off.endDate })
    setShowTimeOffModal(true)
  }

  const handleDeleteTimeOff = (id: string) => {
    const off = formData.timeOff.find(o => o.id === id)
    openConfirmModal('Remove time off?', `This will remove "${off?.name || 'this time off'}" from the team member.`, () => {
      setFormData(prev => ({ ...prev, timeOff: prev.timeOff.filter(o => o.id !== id) }))
      closeConfirmModal()
    })
  }

  const handleSaveTimeOff = () => {
    if (!timeOffFormData.name.trim()) { alert('Please enter a label'); return }
    if (!timeOffFormData.startDate || !timeOffFormData.endDate) { alert('Please select start and end dates'); return }
    const toStart = parseLocalDate(timeOffFormData.startDate); const toEnd = parseLocalDate(timeOffFormData.endDate)
    if (toStart && toEnd && toEnd < toStart) { alert('End date must be after start date'); return }

    if (editingTimeOff) {
      const updatedTimeOff = { ...editingTimeOff, ...timeOffFormData }
      setFormData(prev => ({ ...prev, timeOff: prev.timeOff.map(o => o.id === editingTimeOff.id ? updatedTimeOff : o) }))
    } else {
      const newEntry = { ...timeOffFormData, id: Date.now().toString() }
      setFormData(prev => ({ ...prev, timeOff: [...(prev.timeOff || []), newEntry] }))
    }
    setShowTimeOffModal(false)
  }

  // Quick time-off handlers (calendar click → add time off for signed-in user)
  const findMyTeamMember = (): TeamMember | null => {
    if (!currentUser?.email) return null
    const email = currentUser.email.toLowerCase()
    return team.find(m => {
      if (!m.email) return false
      const memberEmail = m.email.replace(/^mailto:/i, '').toLowerCase()
      return memberEmail === email
    }) || null
  }

  const handleCalendarDateClick = (date: string, dayEvents: CalendarEvent[], dayName: string) => {
    const myMember = findMyTeamMember()
    if (myMember) {
      setQuickTimeOff({ date, member: myMember, editEntry: null, dayEvents, dayName })
      setQuickTimeOffForm({ name: '', startDate: date, endDate: date })
    } else if (dayEvents.length > 0) {
      setSelectedDay({ date, events: dayEvents, dayName })
    }
  }

  const handleQuickTimeOffEdit = (off: { name: string; startDate: string; endDate: string; id: string }) => {
    setQuickTimeOff(prev => prev ? { ...prev, editEntry: off } : null)
    setQuickTimeOffForm({ name: off.name, startDate: off.startDate, endDate: off.endDate })
  }

  const handleQuickTimeOffDelete = (id: string) => {
    if (!quickTimeOff) return
    const off = quickTimeOff.member.timeOff?.find(o => o.id === id)
    openConfirmModal('Remove time off?', `This will remove "${off?.name || 'this time off'}".`, async () => {
      const updatedTimeOff = (quickTimeOff.member.timeOff || []).filter(o => o.id !== id)
      const timeOffStatus = getStatusFromTimeOff(updatedTimeOff)
      const updated = { ...quickTimeOff.member, timeOff: updatedTimeOff, status: timeOffStatus || quickTimeOff.member.status }
      await saveTeamMember(updated)
      setTeam(prev => prev.map(m => m.id === updated.id ? updated : m))
      setQuickTimeOff(prev => prev ? { ...prev, member: updated, editEntry: null } : null)
      refreshCalendar()
      closeConfirmModal()
    })
  }

  const handleQuickTimeOffSave = async () => {
    if (!quickTimeOff) return
    if (!quickTimeOffForm.name.trim()) { alert('Please enter a label'); return }
    if (!quickTimeOffForm.startDate || !quickTimeOffForm.endDate) { alert('Please select start and end dates'); return }
    const toStart = parseLocalDate(quickTimeOffForm.startDate); const toEnd = parseLocalDate(quickTimeOffForm.endDate)
    if (toStart && toEnd && toEnd < toStart) { alert('End date must be after start date'); return }

    let updatedTimeOff: { name: string; startDate: string; endDate: string; id: string }[]
    if (quickTimeOff.editEntry) {
      updatedTimeOff = (quickTimeOff.member.timeOff || []).map(o =>
        o.id === quickTimeOff.editEntry!.id ? { ...o, ...quickTimeOffForm } : o
      )
    } else {
      updatedTimeOff = [...(quickTimeOff.member.timeOff || []), { ...quickTimeOffForm, id: Date.now().toString() }]
    }
    const timeOffStatus = getStatusFromTimeOff(updatedTimeOff)
    const updated = { ...quickTimeOff.member, timeOff: updatedTimeOff, status: timeOffStatus || quickTimeOff.member.status }
    await saveTeamMember(updated)
    setTeam(prev => prev.map(m => m.id === updated.id ? updated : m))
    setQuickTimeOff(prev => prev ? { ...prev, member: updated, editEntry: null } : null)
    setQuickTimeOffForm({ name: '', startDate: quickTimeOff.date, endDate: quickTimeOff.date })
    refreshCalendar()
  }

  const savePriorities = async (blId: string, orderedIds: string[]) => {
    setPriorities(prev => ({ ...prev, [blId]: orderedIds }))
    await authFetch('/api/priorities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_line_id: blId, project_ids: orderedIds }),
    })
  }

  // Track active drag for drag overlay
  const [activeDragProject, setActiveDragProject] = useState<Project | null>(null)
  const [isDraggingFromDone, setIsDraggingFromDone] = useState(false)

  const markProjectDone = async (projectId: string, blId: string, currentRankedIds: string[]) => {
    // Optimistic: update local state
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status: 'done' as const } : p))
    // Remove from priority ranking
    const newRankedIds = currentRankedIds.filter(id => id !== projectId)
    savePriorities(blId, newRankedIds)
    // Persist to backend
    await authFetch(`/api/projects/${projectId}/done`, { method: 'PUT' })
  }

  const markProjectUndone = async (projectId: string, blId: string, currentRankedIds: string[], insertIndex: number) => {
    // Optimistic: restore status to active
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status: 'active' as const } : p))
    // Insert into priority ranking at the specified position
    const newRankedIds = [...currentRankedIds]
    // Remove if already exists (prevent duplicates when dragging from Done)
    const existingIndex = newRankedIds.indexOf(projectId)
    if (existingIndex !== -1) {
      newRankedIds.splice(existingIndex, 1)
      // Adjust insert index if we removed before the insertion point
      if (existingIndex < insertIndex) {
        insertIndex--
      }
    }
    newRankedIds.splice(insertIndex, 0, projectId)
    savePriorities(blId, newRankedIds)
    // Persist to backend
    await authFetch(`/api/projects/${projectId}/undone`, { method: 'PUT' })
  }

  const getCurrentFiscalQuarter = () => {
    const now = new Date()
    return getDjFiscalLabel(now.getMonth() + 1, now.getFullYear())
  }

  const getPreviousFiscalQuarter = () => {
    const now = new Date()
    // Go back ~45 days to land solidly in the previous quarter
    const prev = new Date(now.getFullYear(), now.getMonth() - 2, 1)
    return getDjFiscalLabel(prev.getMonth() + 1, prev.getFullYear())
  }

  const archiveProject = async (projectId: string) => {
    const quarter = getCurrentFiscalQuarter()
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status: 'archived' as const, archivedQuarter: quarter } : p))
    await authFetch(`/api/projects/${projectId}/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quarter })
    })
  }

  const unarchiveProject = async (projectId: string) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, archivedQuarter: null, status: 'active' } : p))
    await authFetch(`/api/projects/${projectId}/unarchive`, { method: 'PUT' })
  }

  const handleQuarterRollover = async () => {
    const quarter = getPreviousFiscalQuarter()
    const doneCount = currentProjects.filter(p => p.status === 'done').length
    if (doneCount === 0) {
      alert('No done projects to archive')
      return
    }
    openConfirmModal(
      `Archive done projects to ${quarter}?`,
      `This will archive ${doneCount} done project${doneCount !== 1 ? 's' : ''} into ${quarter}. They'll move to the archive section and can be restored anytime.`,
      async () => {
        setProjects(prev => prev.map(p => p.status === 'done' && !p.archivedQuarter ? { ...p, status: 'archived' as const, archivedQuarter: quarter } : p))
        await authFetch('/api/quarter-rollover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quarter })
        })
        closeConfirmModal()
      },
      { confirmLabel: 'Archive', danger: false }
    )
  }

  const handleSaveProject = async () => {
    if (!projectFormData.name.trim()) {
      alert('Please enter a project name')
      return
    }

    // Validate start and end dates are required
    if (!projectFormData.startDate) {
      alert('Please select a start date')
      return
    }
    if (!projectFormData.endDate) {
      alert('Please select an end date')
      return
    }
    const parsedStart = parseLocalDate(projectFormData.startDate)
    const parsedEnd = parseLocalDate(projectFormData.endDate)
    if (parsedStart && parsedEnd && parsedEnd < parsedStart) {
      alert('End date must be after start date')
      return
    }
    if (!projectFormData.estimatedHours || projectFormData.estimatedHours <= 0) {
      alert('Please set estimated design hours')
      return
    }
    if (!projectFormData.designers || projectFormData.designers.length === 0) {
      alert('Please assign at least one designer')
      return
    }

    // Validate required links when names are populated
    if (projectFormData.deckName && !projectFormData.deckLink.trim()) {
      alert('Design Deck Link is required when Design Deck Name is provided')
      return
    }
    if (projectFormData.prdName && !projectFormData.prdLink.trim()) {
      alert('PRD Link is required when PRD Name is provided')
      return
    }
    if (projectFormData.briefName && !projectFormData.briefLink.trim()) {
      alert('Design Brief Link is required when Design Brief Name is provided')
      return
    }

    // Warn if estimated hours exceed available capacity in date range (adjusted for designer count)
    if (projectFormData.startDate && projectFormData.endDate && projectFormData.estimatedHours) {
      const availablePerDesigner = calcRangeHours(projectFormData.startDate, projectFormData.endDate)
      const designerCount = (projectFormData.designers || []).length || 1
      const totalAvailable = availablePerDesigner * designerCount
      if (availablePerDesigner > 0 && projectFormData.estimatedHours > totalAvailable) {
        const sizeMap: Record<number, string> = {35:'XXS',70:'XS',105:'S',175:'M',280:'L',455:'XL',910:'XXL'}
        const size = sizeMap[projectFormData.estimatedHours]
        const estLabel = size ? `${size} (${projectFormData.estimatedHours}h)` : `${projectFormData.estimatedHours}h`
        const capacityLabel = designerCount > 1 ? `${totalAvailable}h available across ${designerCount} designers` : `${totalAvailable}h available in the date range`
        if (!confirm(`Estimated effort ${estLabel} exceeds the ${capacityLabel}. Save anyway?`)) {
          return
        }
      }
    }

    if (editingProject) {
      const updated = { ...editingProject, ...projectFormData }
      const success = await saveProject(updated)
      if (!success) return
      setProjects(projects.map(p => p.id === editingProject.id ? updated : p))
      refreshCalendar()
      refreshCapacity()
      refreshProjects()
    } else {
      const newProject: Project = {
        ...projectFormData,
        id: Date.now().toString()
      }
      const success = await saveProject(newProject)
      if (!success) return
      setProjects([...projects, newProject])
      refreshCalendar()
      refreshCapacity()
      refreshProjects()
    }
    
    setShowProjectModal(false)
  }

  
  if (!isLoaded) {
    return (
      <div className="loading" role="status" aria-live="polite">
        <div className="loading-shell">
          <Loader size={32} strokeWidth={1.5} className="spin" style={{ margin: '0 auto 0.75rem', display: 'block', color: 'var(--color-text-muted)' }} />
          <div className="loading-title">Wandi Hub</div>
          <div className="loading-subtitle">Loading dashboard…</div>
        </div>
      </div>
    )
  }


  const getStatusColor = (status: Project['status']) => {
    switch (status) {
      case 'active': return 'bg-blue-500'
      case 'review': return 'bg-yellow-500'
      case 'done': return 'bg-green-500'
      case 'blocked': return 'bg-red-500'
      case 'pending': return 'bg-slate-400'
      case 'archived': return 'bg-stone-500'
    }
  }

  const getStatusLabel = (status: Project['status']) => {
    switch (status) {
      case 'active': return 'Active'
      case 'review': return 'In Review'
      case 'done': return 'Done'
      case 'blocked': return 'Blocked'
      case 'pending': return 'Pending'
      case 'archived': return 'Archived'
    }
  }

  // Get business lines for a team member - combines project assignments + manual selection
  const getMemberBusinessLines = (member: TeamMember): { brand: string; count: number; isManual: boolean }[] => {
    const lines: Record<string, { count: number; isManual: boolean }> = {}
    
    // Add manually selected brands
    member.brands?.forEach(brand => {
      lines[brand] = { count: 0, isManual: true }
    })
    
    // Add project-based business lines
    projects.forEach(project => {
      const bizLines = project.businessLines
      if (project.designers?.includes(member.name) && bizLines && bizLines.length > 0) {
        bizLines.forEach((bl: string) => {
          if (lines[bl]) {
            lines[bl].count += 1
          } else {
            lines[bl] = { count: 1, isManual: false }
          }
        })
      }
    })
    
    return Object.entries(lines)
      .map(([brand, data]) => ({ brand, ...data }))
      .sort((a, b) => a.brand.localeCompare(b.brand))
  }

  // Unused function - keeping for potential future use
  // const _getMemberStatusColor = (status: TeamMember['status']) => {
  //   switch (status) {
  //     case 'online': return 'bg-green-500'
  //     case 'away': return 'bg-yellow-500'
  //     case 'offline': return 'bg-gray-500'
  //   }
  // }

  // Check if current date falls within any time off period
  const getStatusFromTimeOff = (timeOff: { startDate: string; endDate: string }[]): TeamMember['status'] | null => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    for (const off of timeOff) {
      const start = parseLocalDate(off.startDate)
      const end = parseLocalDate(off.endDate)
      if (!start || !end) continue
      if (today >= start && today <= end) {
        return 'away'
      }
    }
    return null
  }

  // Check for nearest upcoming time off
  const getUpcomingTimeOff = (timeOff: { startDate: string; endDate: string; name?: string }[]): { days: number; name: string } | null => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    let nearest: { days: number; name: string } | null = null
    for (const off of timeOff) {
      const start = parseLocalDate(off.startDate)
      if (!start) continue
      const diffTime = start.getTime() - today.getTime()
      const diffDays = Math.ceil(diffTime / DAY_MS)
      if (diffDays > 0) {
        if (!nearest || diffDays < nearest.days) {
          nearest = { days: diffDays, name: off.name || 'Time Off' }
        }
      }
    }
    return nearest
  }

  // Gantt chart helper functions
  const getGanttRange = (project: Project) => {
    const dates: Date[] = []
    if (project.timeline) {
      project.timeline.forEach(t => {
        const start = parseLocalDate(t.startDate)
        const end = parseLocalDate(t.endDate)
        if (start) dates.push(start)
        if (end) dates.push(end)
      })
    }

    // Add project start and end dates to the range
    if (project.startDate) {
      const start = parseLocalDate(project.startDate)
      if (start) dates.push(start)
    }
    if (project.endDate) {
      const end = parseLocalDate(project.endDate)
      if (end) dates.push(end)
    }

    if (dates.length === 0) return null

    const minDate = new Date(Math.min(...dates.map(d => d.getTime())))
    const maxDate = new Date(Math.max(...dates.map(d => d.getTime())))

    // No synthetic padding: use real project/timeline boundaries for accurate scale
    minDate.setHours(12, 0, 0, 0)
    maxDate.setHours(12, 0, 0, 0)

    const totalDays = Math.max(1, (maxDate.getTime() - minDate.getTime()) / DAY_MS)
    return { start: minDate, end: maxDate, totalDays }
  }

  const getGanttBarStyle = (range: TimelineRange, ganttRange: { start: Date; end: Date; totalDays: number }) => {
    const start = parseLocalDate(range.startDate)
    const end = parseLocalDate(range.endDate)
    if (!start || !end) return { left: '0%', width: '0%' }

    const startOffsetDays = (start.getTime() - ganttRange.start.getTime()) / DAY_MS
    const durationDays = Math.max(1, (end.getTime() - start.getTime()) / DAY_MS + 1)

    const left = (startOffsetDays / ganttRange.totalDays) * 100
    const width = (durationDays / ganttRange.totalDays) * 100

    const clampedLeft = Math.max(0, Math.min(100, left))
    const clampedWidth = Math.max(0, Math.min(100 - clampedLeft, width))

    return { left: `${clampedLeft}%`, width: `${clampedWidth}%` }
  }

  // Sort team by name (fixed - no sort UI)
  const sortedTeam = [...team].map(m => {
    // Recompute status based on current time off dates
    const timeOffStatus = getStatusFromTimeOff(m.timeOff || [])
    // If no active time-off but status is stale 'away', reset to 'online'
    const status = timeOffStatus || (m.status === 'away' ? 'online' : m.status)
    return { ...m, status }
  }).sort((a, b) => {
    return a.name.localeCompare(b.name)
  })

  // Separate archived from current projects
  const currentProjects = projects.filter(p => p.status !== 'archived')
  const archivedProjects = projects.filter(p => p.status === 'archived')
  const archivedByQuarter = archivedProjects.reduce<Record<string, Project[]>>((acc, p) => {
    const q = p.archivedQuarter!
    ;(acc[q] ||= []).push(p)
    return acc
  }, {})

  // Status priority: blocked first, then review, active, done last
  const statusOrder: Record<string, number> = { blocked: 0, review: 1, active: 2, done: 3, pending: 4, archived: 5 }
  const getStatusOrder = (s: string) => statusOrder[s] ?? 2

  // Sort projects by selected criteria (only current/non-archived)
  const sortedProjects = [...currentProjects].sort((a, b) => {
    // Always push "done" to the end regardless of sort mode
    const statusDiff = getStatusOrder(a.status) - getStatusOrder(b.status)
    if (statusDiff !== 0) return statusDiff

    switch (projectSortBy) {
      case 'name':
        return a.name.localeCompare(b.name)
      case 'businessLine':
        return (a.businessLines?.[0] || '').localeCompare(b.businessLines?.[0] || '')
      case 'designer': {
        const designerA = a.designers?.[0] || ''
        const designerB = b.designers?.[0] || ''
        return designerA.localeCompare(designerB)
      }
      case 'dueDate': {
        const dateA = a.endDate || ''
        const dateB = b.endDate || ''
        if (!dateA && !dateB) return 0
        if (!dateA) return 1
        if (!dateB) return -1
        return dateA.localeCompare(dateB)
      }
      case 'status':
        return a.name.localeCompare(b.name)
      default:
        return 0
    }
  })

  // Filter projects based on active filters
  const filteredProjects = sortedProjects.filter(project => {
    // Project filter (from day modal click)
    if (projectFilters.project && project.name !== projectFilters.project) {
      return false
    }
    
    // Business Line filter
    if (projectSortBy === 'businessLine' && projectFilters.businessLines.length > 0) {
      if (!project.businessLines || !project.businessLines.some((bl: string) => projectFilters.businessLines.includes(bl))) {
        return false
      }
    }
    
    // Designer filter - only remove if ALL designers are disabled
    if (projectSortBy === 'designer' && projectFilters.designers.length > 0) {
      if (!project.designers || project.designers.length === 0) {
        return false // No designers = can't match any filter
      }
      // Keep project only if at least one designer is enabled
      const hasEnabledDesigner = project.designers.some(d => projectFilters.designers.includes(d))
      if (!hasEnabledDesigner) {
        return false
      }
    }
    
    // Status filter
    if (projectSortBy === 'status' && projectFilters.statuses.length > 0) {
      if (!projectFilters.statuses.includes(project.status)) {
        return false
      }
    }
    
    return true
  })

  // Get unique business lines from projects (use brandOptions for full list)
  const projectBusinessLines = brandOptions
  
  // Get unique designers from team
  const projectDesigners = [...new Set(team.map(m => m.name))].sort()
  
  // Get unique statuses
  const projectStatuses = ['active', 'review', 'done', 'blocked', 'pending'].sort()

  // Determine if filter UI should show
  const showProjectFilter = () => {
    return ['businessLine', 'designer', 'status'].includes(projectSortBy)
  }

  // Toggle filter helper
  const toggleBusinessLineFilter = (brand: string) => {
    setProjectFilters(prev => ({
      ...prev,
      businessLines: prev.businessLines.includes(brand)
        ? prev.businessLines.filter(b => b !== brand)
        : [...prev.businessLines, brand]
    }))
  }

  const toggleDesignerFilter = (designer: string) => {
    setProjectFilters(prev => ({
      ...prev,
      designers: prev.designers.includes(designer)
        ? prev.designers.filter(d => d !== designer)
        : [...prev.designers, designer]
    }))
  }

  const toggleStatusFilter = (status: string) => {
    setProjectFilters(prev => ({
      ...prev,
      statuses: prev.statuses.includes(status)
        ? prev.statuses.filter(s => s !== status)
        : [...prev.statuses, status]
    }))
  }

  // Handle sort change
  const handleProjectSortChange = (newSort: typeof projectSortBy) => {
    setProjectSortBy(newSort)
    // Clear filters when switching sorts (user manually enables what they want)
    setProjectFilters({
      businessLines: [],
      designers: [],
      statuses: [],
      project: null
    })
  }

  const handleAddMember = () => {
    setEditingMember(null)
    setFormData({ name: '', role: '', brands: ["Barron's"], status: 'offline', slack: '', email: '', timeOff: [] })
    setShowModal(true)
  }

  const handleEditMember = (member: TeamMember) => {
    setEditingMember(member)
    setFormData({ name: member.name, role: member.role, brands: member.brands, status: member.status, slack: member.slack || '', email: member.email || '', timeOff: member.timeOff || [] })
    setShowModal(true)
  }

  const handleDeleteMember = async (id: string) => {
    openConfirmModal('Remove team member?', 'This will remove the team member and related assignment links.', async () => {
      await deleteTeamMember(id)
      setTeam(team.filter(m => m.id !== id))
      
      closeConfirmModal()
    })
  }

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.role.trim()) {
      alert('Please fill in name and role')
      return
    }

    // Auto-set status to away if current date falls within time off
    const timeOffStatus = getStatusFromTimeOff(formData.timeOff || [])
    const finalStatus = timeOffStatus || formData.status

    if (editingMember) {
      const updated = { ...editingMember, ...formData, status: finalStatus }
      await saveTeamMember(updated)
      setTeam(prev => prev.map(m => m.id === editingMember.id ? updated : m))
      refreshCalendar()
    } else {
      const newMember: TeamMember = {
        ...formData,
        id: Date.now().toString(),
        status: finalStatus
      }
      await saveTeamMember(newMember)
      setTeam(prev => [...prev, newMember])
      refreshCalendar()
    }
    
    setShowModal(false)
  }

  // Show loading while checking auth
  if (isLoading) {
    return (
      <div className="login-page">
        <div className="loading-placeholder">
          <Loader size={48} strokeWidth={1.5} className="spin" />
        </div>
      </div>
    )
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-lockup">
            <LayoutGrid size={23} />
            <h1>Wandi Hub</h1>
            <button className="changelog-toggle" onClick={() => setShowChangelog(v => !v)} aria-label="What's new">
              <Info size={15} />
            </button>
          </div>

          {showChangelog && (
            <div className="changelog-popover">
              <div className="changelog-title">What's new</div>
              <ul className="changelog-list">
                {CHANGELOG.map((item, i) => {
                  const dash = item.indexOf('—')
                  if (dash === -1) return <li key={i}>{item}</li>
                  return <li key={i}><strong>{item.slice(0, dash).trim()}</strong> — {item.slice(dash + 1).trim()}</li>
                })}
              </ul>
            </div>
          )}

          <form className="login-form" onSubmit={handleLogin} action="/api/auth/login" method="post" autoComplete="on">
            {loginError && <div className="login-error">{loginError}</div>}
            <div className="form-field">
              <label htmlFor="login-email" className="sr-only">Email</label>
              <input
                id="login-email"
                name="username"
                type="email"
                autoComplete="username"
                placeholder="Email"
                value={loginForm.email}
                onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="login-password" className="sr-only">Password</label>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={loginForm.password}
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                required
              />
            </div>
            <button type="submit" className="login-btn">Sign In</button>
          </form>
        </div>
      </div>
    )
  }

  // Show lockout screen for non-admin users when maintenance lockout is active
  if (maintenance.enabled && maintenance.isLockout && currentUser?.role !== 'admin') {
    return (
      <div className="maintenance-lockout">
        <div className="maintenance-lockout-card">
          <div className="maintenance-lockout-icon">&#128736;</div>
          <h1>Scheduled Maintenance</h1>
          <p>{maintenance.lockoutMessage || 'Wandi Hub is being improved. Back as soon as possible.'}</p>
          <div className="maintenance-lockout-status">
            <span className="maintenance-pulse" />
            This page updates automatically
          </div>
          <button
            className="maintenance-admin-link"
            onClick={() => {
              handleLogout()
            }}
          >
            Admin access
          </button>
        </div>
      </div>
    )
  }

  const showMaintenanceBanner = maintenance.enabled && !!maintenance.bannerMessage && (!maintenance.isLockout || isAdmin)

  return (
    <>
      {/* Maintenance Banner — fixed above everything */}
      {showMaintenanceBanner && (
        <div className="maintenance-banner">
          <span className="maintenance-banner-text">
            {maintenance.isLockout ? 'Maintenance mode active — site is locked out for users' : maintenance.bannerMessage}
            {!maintenance.isLockout && countdownDisplay && <span className="maintenance-banner-countdown"> &mdash; {countdownDisplay}</span>}
          </span>
        </div>
      )}
      {/* Update available banner */}
      {updateAvailable && (
        <div className="update-banner" onClick={() => window.location.reload()}>
          A new version of Wandi Hub is available. Click to refresh.
        </div>
      )}
    <div className={`app${showMaintenanceBanner || updateAvailable ? ' has-maintenance-banner' : ''}`}>
      {/* Sidebar */}
      <aside className={`sidebar ${navCollapsed ? 'sidebar-collapsed' : ''}`}>
        <div className="logo">
          <LayoutGrid size={22} className="logo-icon" />
          <span className="logo-text">Wandi Hub</span>
        </div>
        
        <nav className="nav">
          <button
            className={`nav-item ${activeTab === 'projects' ? 'active' : ''}`}
            onClick={() => { setActiveTab('projects') }}
            aria-label="Projects"
          >
            <span className="nav-icon"><FileText size={18} /></span>
            <span className="nav-label">Projects</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'capacity' ? 'active' : ''}`}
            onClick={() => { setActiveTab('capacity') }}
            aria-label="Capacity"
          >
            <span className="nav-icon"><Gauge size={18} /></span>
            <span className="nav-label">Capacity</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'calendar' ? 'active' : ''}`}
            onClick={() => { setActiveTab('calendar') }}
            aria-label="Calendar"
          >
            <span className="nav-icon"><Calendar size={18} /></span>
            <span className="nav-label">Calendar</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'team' ? 'active' : ''}`}
            onClick={() => { setActiveTab('team') }}
            aria-label="Team"
          >
            <span className="nav-icon"><Users size={18} /></span>
            <span className="nav-label">Team</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'reports' ? 'active' : ''}`}
            onClick={() => { setActiveTab('reports') }}
            aria-label="Reports"
          >
            <span className="nav-icon"><FileBarChart size={18} /></span>
            <span className="nav-label">Reports</span>
            <span className="nav-badge-beta">beta</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'reviews' ? 'active' : ''}`}
            onClick={() => { setActiveTab('reviews') }}
            aria-label="Reviews"
          >
            <span className="nav-icon"><ListChecks size={18} /></span>
            <span className="nav-label">Reviews</span>
            <span className="nav-badge-beta">beta</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <button
            className={`nav-item${activeTab === 'settings' ? ' active' : ''}`}
            onClick={() => { setActiveTab('settings') }}
          >
            <span className="nav-icon"><Settings size={18} /></span>
            <span className="nav-label">Settings</span>
          </button>
          <button className="nav-item nav-collapse-toggle" onClick={toggleNavCollapsed} aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}>
            <span className="nav-icon">{navCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}</span>
            <span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main">
        {/* Header */}
        <header className="header">
          <div className="header-title">
            <h1>
              {activeTab === 'projects' && 'Projects'}
              {activeTab === 'team' && 'Team'}
              {activeTab === 'calendar' && 'Calendar'}
              {activeTab === 'capacity' && 'Capacity'}
              {activeTab === 'reports' && 'Reports'}
              {activeTab === 'reviews' && 'Reviews'}
              {activeTab === 'settings' && 'Settings'}
            </h1>
            <p className="date">{getTodayFormatted()}</p>
          </div>
          
          <div className="header-actions">
            <button className="icon-btn" aria-label="Search" onClick={() => setShowSearch(true)}>
              <Search size={18} />
            </button>
            <div className="notif-wrapper" ref={notifRef}>
              <button className="icon-btn" aria-label="Notifications" onClick={openNotifications}>
                <Bell size={18} />
                {hasUnseenActivity && <span className="notif-dot" />}
              </button>
              {showNotifications && (
                <div className="notif-panel">
                  <div className="notif-panel-header">
                    <h3>Recent Activity</h3>
                  </div>
                  {activityItems.length === 0 ? (
                    <div className="notif-empty">No recent updates</div>
                  ) : (
                    <div className="notif-list">
                      {(() => {
                        const grouped: Record<string, ActivityItem[]> = {}
                        for (const item of activityItems) {
                          const d = new Date(item.created_at + 'Z')
                          const today = new Date()
                          const yesterday = new Date(today)
                          yesterday.setDate(yesterday.getDate() - 1)
                          let label: string
                          if (d.toDateString() === today.toDateString()) label = 'Today'
                          else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday'
                          else label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
                          if (!grouped[label]) grouped[label] = []
                          grouped[label].push(item)
                        }
                        return Object.entries(grouped).map(([day, items]) => (
                          <div key={day} className="notif-day-group">
                            <div className="notif-day-label">{day}</div>
                            {items.map(item => (
                              <div key={item.id} className="notif-item">
                                <div className="notif-item-icon" data-category={item.category}>
                                  {item.category === 'project' && <LayoutGrid size={14} />}
                                  {item.category === 'priority' && <GripVertical size={14} />}
                                  {item.category === 'holiday' && <Calendar size={14} />}
                                  {item.category === 'capacity' && <Gauge size={14} />}
                                </div>
                                <div className="notif-item-content">
                                  <div className="notif-item-title">
                                    <span className="notif-action">{item.action === 'create' ? 'Created' : item.action === 'update' ? 'Updated' : 'Deleted'}</span>
                                    {' '}{item.target_name}
                                  </div>
                                  {item.details && <div className="notif-item-detail">{item.details}</div>}
                                  <div className="notif-item-meta">
                                    {item.user_email !== 'anonymous' ? item.user_email.split('@')[0] : 'System'} · {new Date(item.created_at + 'Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
            {activeTab === 'projects' && !showArchive && (
              <button className="primary-btn" onClick={handleAddProject}>+ New Project</button>
            )}
            {activeTab === 'team' && (
              <button className="primary-btn" onClick={handleAddMember}>+ Add Member</button>
            )}
          </div>
        </header>

        {/* Content Area */}
        <div ref={contentRef} className={`content ${activeTab === 'calendar' ? 'content-calendar' : ''}`}>
          {activeTab === 'projects' && (
            <div className="projects-grid">
              <div className="projects-sort-row">
                {!showArchive && <label className="arrange-priority-toggle">
                  <div className={`toggle-switch ${projectViewMode === 'priority' ? 'active' : ''}`} onClick={() => setProjectViewMode(projectViewMode === 'priority' ? 'list' : 'priority')}>
                    <div className="toggle-knob" />
                  </div>
                  <span className="toggle-label" onClick={() => setProjectViewMode(projectViewMode === 'priority' ? 'list' : 'priority')}>Arrange priority</span>
                </label>}
                {!showArchive && <div className="sort-divider" />}
                {showArchive ? (
                  <button className="archive-back-btn" onClick={() => setShowArchive(false)}>
                    <ChevronLeft size={14} />
                    Back to active projects
                  </button>
                ) : projectViewMode === 'list' ? (
                  <>
                    <span className="sort-label">Sort by:</span>
                    <button className={`sort-btn ${projectSortBy === 'name' ? 'active' : ''}`} onClick={() => handleProjectSortChange('name')}>Name</button>
                    <button className={`sort-btn ${projectSortBy === 'businessLine' ? 'active' : ''}`} onClick={() => handleProjectSortChange('businessLine')}>Business Line</button>
                    <button className={`sort-btn ${projectSortBy === 'designer' ? 'active' : ''}`} onClick={() => handleProjectSortChange('designer')}>Designer</button>
                    <button className={`sort-btn ${projectSortBy === 'dueDate' ? 'active' : ''}`} onClick={() => handleProjectSortChange('dueDate')}>Due Date</button>
                    <button className={`sort-btn ${projectSortBy === 'status' ? 'active' : ''}`} onClick={() => handleProjectSortChange('status')}>Status</button>
                  </>
                ) : (
                  <>
                    <span className="sort-label">Business Line:</span>
                    <select
                      className="priority-bl-select"
                      value={priorityBusinessLine || 'all'}
                      onChange={e => setPriorityBusinessLine(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option disabled>──────────</option>
                      {businessLines.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </>
                )}
                {!showArchive && archivedProjects.length > 0 && (
                  <>
                    <div className="sort-divider" style={{ marginLeft: 'auto' }} />
                    <button className="archive-view-btn" onClick={() => setShowArchive(true)}>
                      <Archive size={13} />
                      Archive ({archivedProjects.length})
                    </button>
                  </>
                )}
              </div>

              {/* Archive View */}
              {showArchive && (
                <div className="archive-view">
                  {archivedProjects.length === 0 ? (
                    <div className="archive-empty">
                      <Archive size={32} />
                      <p>No archived projects yet</p>
                      <p className="archive-empty-hint">Done projects will appear here after a quarter rollover</p>
                    </div>
                  ) : (
                    Object.entries(archivedByQuarter)
                      .sort(([a], [b]) => b.localeCompare(a))
                      .map(([quarter, qProjects]) => {
                        const byBL: Record<string, Project[]> = {}
                        qProjects.forEach(p => {
                          const bl = (p.businessLines && p.businessLines.length > 0) ? p.businessLines[0] : 'Unassigned'
                          ;(byBL[bl] ||= []).push(p)
                        })
                        return (
                        <div key={quarter} className="archive-quarter-group">
                          <div className="archive-quarter-header">
                            <span className="archive-quarter-label">{quarter}</span>
                            <span className="archive-quarter-count">{qProjects.length} project{qProjects.length !== 1 ? 's' : ''}</span>
                          </div>
                          {Object.entries(byBL).sort(([a], [b]) => a.localeCompare(b)).map(([bl, blProjects]) => (
                            <div key={bl} className="archive-bl-group">
                              <div className="archive-bl-header">
                                <Folder size={12} />
                                <span>{bl}</span>
                                <span className="archive-bl-count">{blProjects.length}</span>
                              </div>
                              <div className="archive-cards">
                                {blProjects.sort((a, b) => a.name.localeCompare(b.name)).map(p => (
                                  <div key={p.id} className="archive-card">
                                    <div className="archive-card-header">
                                      <span className="archive-card-name">{p.name}</span>
                                      <div style={{ display: 'flex', gap: '0.35rem' }}>
                                        <button className="archive-restore-btn" title="Duplicate as new active project" onClick={() => {
                                          const phase = p.name.match(/Phase\s+(\d+)/i)
                                          const nextPhase = phase ? parseInt(phase[1]) + 1 : 2
                                          const newName = phase
                                            ? p.name.replace(/Phase\s+\d+/i, `Phase ${nextPhase}`)
                                            : `${p.name} (Phase ${nextPhase})`
                                          setProjectFormData({
                                            name: newName,
                                            description: p.description || '',
                                            url: p.url || '',
                                            status: 'active',
                                            startDate: '',
                                            endDate: '',
                                            designers: p.designers || [],
                                            businessLines: p.businessLines || [],
                                            deckName: p.deckName || '',
                                            deckLink: p.deckLink || '',
                                            prdName: p.prdName || '',
                                            prdLink: p.prdLink || '',
                                            briefName: p.briefName || '',
                                            briefLink: p.briefLink || '',
                                            figmaLink: p.figmaLink || '',
                                            customLinks: p.customLinks || [],
                                            timeline: p.timeline || [],
                                            estimatedHours: 0,
                                          })
                                          setEditingProject(null)
                                          setShowProjectModal(true)
                                        }}>
                                          <Copy size={13} />
                                          Duplicate
                                        </button>
                                        <button className="archive-restore-btn" title="Restore to active projects" onClick={() => unarchiveProject(p.id)}>
                                          <RotateCcw size={13} />
                                          Restore
                                        </button>
                                      </div>
                                    </div>
                                    <div className="archive-card-meta">
                                      {p.designers && p.designers.length > 0 && (
                                        <span className="archive-card-tag">{p.designers.length > 1 ? <Users size={12} /> : <User size={12} />}{p.designers.map(d => d.split(' ')[0]).join(', ')}</span>
                                      )}
                                      {p.startDate && p.endDate && (
                                        <span className="archive-card-tag"><Calendar size={12} />{formatShortDate(p.startDate)} – {formatShortDate(p.endDate)}</span>
                                      )}
                                      {(p.estimatedHours || 0) > 0 && (
                                        <span className="archive-card-tag"><Clock size={12} />{p.estimatedHours}h</span>
                                      )}
                                    </div>
                                    {(p.deckLink || p.prdLink || p.briefLink || p.figmaLink || (p.customLinks && p.customLinks.length > 0)) && (
                                      <div className="archive-card-links">
                                        {p.deckLink && <a href={p.deckLink} target="_blank" rel="noopener noreferrer"><Presentation size={12} />{p.deckName || 'Deck'}</a>}
                                        {p.prdLink && <a href={p.prdLink} target="_blank" rel="noopener noreferrer"><FileText size={12} />{p.prdName || 'PRD'}</a>}
                                        {p.briefLink && <a href={p.briefLink} target="_blank" rel="noopener noreferrer"><FileEdit size={12} />{p.briefName || 'Brief'}</a>}
                                        {p.figmaLink && <a href={p.figmaLink} target="_blank" rel="noopener noreferrer"><Figma size={12} />Figma</a>}
                                        {p.customLinks?.map((link: any, idx: number) => (
                                          <a key={idx} href={link.url} target="_blank" rel="noopener noreferrer"><LinkIcon size={12} />{link.name}</a>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                        )
                      })
                  )}
                </div>
              )}

              {/* Divider line under business line picker in priority All view */}
              {!showArchive && projectViewMode === 'priority' && priorityBusinessLine === 'all' && (
                <div className="priority-all-divider" />
              )}

              {/* Project Filters - hidden in priority mode and archive mode */}
              {!showArchive && projectViewMode === 'list' && showProjectFilter() && (
                <div className="projects-filter-row">
                  {projectSortBy === 'businessLine' && (
                    <>
                      <span className="filter-label">Filter:</span>
                      {projectBusinessLines.map(brand => (
                        <button
                          key={brand}
                          className={`filter-pill ${projectFilters.businessLines.includes(brand) ? 'active' : ''}`}
                          onClick={() => toggleBusinessLineFilter(brand)}
                        >
                          {brand}
                        </button>
                      ))}
                    </>
                  )}
                  {projectSortBy === 'designer' && (
                    <>
                      <span className="filter-label">Filter:</span>
                      {projectDesigners.map(designer => (
                        <button
                          key={designer}
                          className={`filter-pill ${projectFilters.designers.includes(designer) ? 'active' : ''}`}
                          onClick={() => toggleDesignerFilter(designer)}
                        >
                          {designer}
                        </button>
                      ))}
                    </>
                  )}
                  {projectSortBy === 'status' && (
                    <>
                      <span className="filter-label">Filter:</span>
                      {projectStatuses.map(status => (
                        <button
                          key={status}
                          className={`filter-pill ${projectFilters.statuses.includes(status) ? 'active' : ''}`}
                          onClick={() => toggleStatusFilter(status)}
                        >
                          {status === 'active' ? 'Active' : status === 'review' ? 'In Review' : status === 'done' ? 'Done' : status === 'blocked' ? 'Blocked' : 'Pending'}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* Active Project Filter (from day modal) */}
              {!showArchive && projectFilters.project && (
                <div className="projects-filter-row">
                  <span className="filter-label">Showing:</span>
                  <button
                    className="filter-pill active"
                    onClick={() => setProjectFilters({ ...projectFilters, project: null })}
                  >
                    {projectFilters.project} ×
                  </button>
                </div>
              )}

              {!showArchive && projectViewMode === 'list' && (() => {
                const now = new Date()
                const in4Weeks = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000)
                const summaryProjects = filteredProjects
                const activeProjects = summaryProjects.filter(p => p.status === 'active' || p.status === 'review')
                const activeAssignments = capacityData?.assignments.filter((a: CapacityAssignment) => {
                  const proj = summaryProjects.find(p => p.name === a.project_name)
                  return proj && (proj.status === 'active' || proj.status === 'review')
                }) || []
                const warnings: { icon: React.ReactNode; text: string; severity: 'danger' | 'warn' | 'info'; detail?: { title: string; items: { name: string; detail: string; projectName?: string }[] } }[] = []

                const overdue = activeProjects.filter(p => {
                  if (!p.endDate) return false
                  const end = parseLocalDate(p.endDate)
                  return end && end < now
                })
                if (overdue.length > 0) warnings.push({
                  icon: <AlertTriangle size={12} />, text: `${overdue.length} past end date`, severity: 'danger',
                  detail: { title: 'Projects Past End Date', items: overdue.map(p => {
                    const end = parseLocalDate(p.endDate!)!
                    const days = Math.round((now.getTime() - end.getTime()) / (24 * 60 * 60 * 1000))
                    return { name: p.name, detail: `${days}d overdue · ended ${formatShortDate(p.endDate!)}`, projectName: p.name }
                  })}
                })

                const multiDesigner = activeProjects.filter(p => {
                  const designers = activeAssignments.filter((a: CapacityAssignment) => a.project_name === p.name)
                  return designers.length > 1
                })
                if (multiDesigner.length > 0) warnings.push({
                  icon: <Users size={12} />, text: `${multiDesigner.length} multi-designer`, severity: 'info',
                  detail: { title: 'Multi-Designer Projects', items: multiDesigner.map(p => {
                    const designers = activeAssignments.filter((a: CapacityAssignment) => a.project_name === p.name)
                    const names = designers.map((a: CapacityAssignment) => {
                      const tm = team.find(t => t.id === a.designer_id)
                      return tm?.name.split(' ')[0] || a.designer_name || '?'
                    }).join(', ')
                    return { name: p.name, detail: names, projectName: p.name }
                  })}
                })

                const noEstimate = activeProjects.filter(p => !p.estimatedHours)
                if (noEstimate.length > 0) warnings.push({
                  icon: <FileBarChart size={12} />, text: `${noEstimate.length} missing estimates`, severity: 'warn',
                  detail: { title: 'Projects Missing Estimates', items: noEstimate.map(p => {
                    const designerCount = (p.designers || []).length
                    return { name: p.name, detail: `${designerCount} designer${designerCount !== 1 ? 's' : ''}, no hours estimated`, projectName: p.name }
                  })}
                })

                const endingSoon = activeProjects.filter(p => {
                  if (!p.endDate) return false
                  const end = parseLocalDate(p.endDate)
                  return end && end > now && end <= in4Weeks
                })
                if (endingSoon.length > 0) warnings.push({
                  icon: <Flag size={12} />, text: `${endingSoon.length} ending soon`, severity: 'info',
                  detail: { title: 'Projects Ending Soon', items: endingSoon.map(p => {
                    const end = parseLocalDate(p.endDate!)!
                    const days = Math.round((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
                    return { name: p.name, detail: `${days}d left · ends ${formatShortDate(p.endDate!)}`, projectName: p.name }
                  })}
                })

                const ptoConflictDetails: { name: string; detail: string; projectName?: string }[] = []
                activeProjects.forEach(p => {
                  const projDesignerIds = activeAssignments.filter((a: CapacityAssignment) => a.project_name === p.name).map((a: CapacityAssignment) => a.designer_id)
                  if (projDesignerIds.length < 2) return
                  const ptoRanges = projDesignerIds.map(did => {
                    const tm = team.find(t => t.id === did)
                    if (!tm?.timeOff) return []
                    return tm.timeOff.filter(to => { const end = parseLocalDate(to.endDate); return end && end >= now }).map(to => ({ did, name: tm.name, start: parseLocalDate(to.startDate)!, end: parseLocalDate(to.endDate)! }))
                  }).flat()
                  const conflicts: string[] = []
                  for (let i = 0; i < ptoRanges.length; i++) {
                    for (let j = i + 1; j < ptoRanges.length; j++) {
                      if (ptoRanges[i].did !== ptoRanges[j].did && ptoRanges[i].start <= ptoRanges[j].end && ptoRanges[j].start <= ptoRanges[i].end) {
                        conflicts.push(`${ptoRanges[i].name.split(' ')[0]} & ${ptoRanges[j].name.split(' ')[0]}`)
                      }
                    }
                  }
                  if (conflicts.length > 0) ptoConflictDetails.push({ name: p.name, detail: conflicts.join('; '), projectName: p.name })
                })
                if (ptoConflictDetails.length > 0) warnings.push({
                  icon: <Calendar size={12} />, text: `${ptoConflictDetails.length} PTO overlap`, severity: 'warn',
                  detail: { title: 'Overlapping PTO on Projects', items: ptoConflictDetails }
                })

                const visibleProjectIds = new Set(summaryProjects.map(p => p.id))
                const scopedMissingUpdates = missingUpdates.filter(m => visibleProjectIds.has(m.id))
                if (scopedMissingUpdates.length > 0) warnings.push({
                  icon: <ClipboardCopy size={12} />, text: `${scopedMissingUpdates.length} missing weekly updates`, severity: 'warn',
                  detail: { title: 'Projects Missing Weekly Updates', items: scopedMissingUpdates.map(p => {
                    return { name: p.name, detail: `No update for ${currentWeek}`, projectName: p.name }
                  })}
                })

                return (
                  <div className="projects-summary">
                    <div className="summary-stats">
                      {([['active', 'Active', '#3b82f6'], ['review', 'In Review', '#f59e0b'], ['done', 'Done', '#22c55e'], ['blocked', 'Blocked', '#ef4444'], ['pending', 'Pending', '#94a3b8']] as const).map(([status, label, color]) => {
                        const count = summaryProjects.filter(p => p.status === status).length
                        return (
                          <div key={status} className="summary-stat" style={count > 0 ? { color } : undefined}>
                            <span className="summary-stat-value">{count}</span>
                            <span className="summary-stat-label">{label}</span>
                          </div>
                        )
                      })}
                    </div>
                    {warnings.length > 0 && (
                      <div className="summary-risks">
                        {warnings.map((w, i) => (
                          <div key={i} className={`risk-item risk-${w.severity}${w.detail ? ' risk-clickable' : ''}`} onClick={() => w.detail && setRiskDetail(w.detail)}>
                            <span className="risk-icon">{w.icon}</span>
                            <span className="risk-text">{w.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

              {!showArchive && projectViewMode === 'list' && <div className="projects-list">
                {(() => {
                  if (filteredProjects.length === 0) return <div className="priority-empty">No projects found</div>

                  const renderProjectRow = (project: any) => {
                    const isOverdue = (() => {
                      if (!project.endDate || project.status === 'done' || project.status === 'pending') return false
                      const end = parseLocalDate(project.endDate)
                      if (!end) return false
                      const today = new Date()
                      today.setHours(12, 0, 0, 0)
                      return end < today
                    })()

                    return (
                      <div key={project.id} className="project-row">
                        <div className="project-info">
                          <div className="project-info-top">
                            <span className="project-name-cell">
                              {isOverdue && <span className="overdue-label">Overdue</span>}
                              <span className="project-name">{project.name}{project.url && <a href={project.url} target="_blank" rel="noopener noreferrer" className="project-jira-badge" onClick={e => e.stopPropagation()}>JIRA</a>}</span>
                            </span>
                            <span className="status-badge" style={{ color: { active: '#3b82f6', review: '#f59e0b', done: '#22c55e', blocked: '#ef4444', pending: '#94a3b8', archived: '#78716c' }[project.status as string] }}>
                              <span className={`status-badge-dot ${getStatusColor(project.status)}`}></span>
                              {getStatusLabel(project.status)}
                            </span>
                          </div>
                          {project.description && (
                            <div className="project-description">{project.description}</div>
                          )}
                          <div className="project-meta">
                            {(project.designers || []).length > 0 ? (
                              <span className="project-meta-chip">
                                {(project.designers || []).length > 1 ? <Users size={11} /> : <User size={11} />}
                                {(project.designers || []).map((d: string) => d.split(' ')[0]).join(', ')}
                              </span>
                            ) : project.status !== 'done' && project.status !== 'pending' ? (
                              <span className="project-meta-chip project-meta-warn">
                                <User size={11} /> No designer
                              </span>
                            ) : null}
                            {(project.estimatedHours || 0) > 0 ? (
                              <span className="project-meta-chip">
                                <Clock size={11} />
                                {(() => {
                                  const sizeMap: Record<number, string> = {35:'XXS',70:'XS',105:'S',175:'M',280:'L',455:'XL',910:'XXL'}
                                  const size = sizeMap[project.estimatedHours || 0]
                                  const weeks = Math.round((project.estimatedHours || 0) / 35 * 10) / 10
                                  return <>{size ? `${size} · ` : ''}{project.estimatedHours}h ({weeks}w)</>
                                })()}
                              </span>
                            ) : project.status !== 'done' && project.status !== 'pending' ? (
                              <span className="project-meta-chip project-meta-warn">
                                <Clock size={11} /> No estimate
                              </span>
                            ) : null}
                            <span className="project-meta-spacer" />
                            <span className="project-meta-chip project-meta-action" onClick={() => {
                              const url = `${window.location.origin}${window.location.pathname}#/projects?project=${encodeURIComponent(project.name)}`
                              navigator.clipboard.writeText(url)
                              setCopiedReport(Date.now())
                              setTimeout(() => setCopiedReport(null), 2000)
                            }}>
                              <LinkIcon size={11} /> Copy Link
                            </span>
                            <span className="project-meta-chip project-meta-action" onClick={() => handleEditProject(project)}>
                              <Pencil size={11} /> Edit
                            </span>
                            <span className="project-meta-chip project-meta-action" onClick={() => archiveProject(project.id)}>
                              <Archive size={11} /> Archive
                            </span>
                            <span className="project-meta-chip project-meta-action project-meta-action-delete" onClick={() => handleDeleteProject(project.id)}>
                              <Trash2 size={11} /> Delete
                            </span>
                          </div>
                        </div>
                        {((project.timeline && project.timeline.length > 0) || (project.startDate && project.endDate)) && (() => {
                            const ganttRange = getGanttRange(project)
                            if (!ganttRange) return null
                            const today = new Date()
                            today.setHours(12, 0, 0, 0)
                            const isTodayInRange = today >= ganttRange.start && today <= ganttRange.end
                            const todayPosition = isTodayInRange
                              ? ((today.getTime() - ganttRange.start.getTime()) / DAY_MS / ganttRange.totalDays) * 100
                              : null
                            const weeklyTickCount = Math.max(1, Math.ceil(ganttRange.totalDays / 7))
                            const weeklyTickPositions = Array.from({ length: weeklyTickCount + 1 }, (_, i) => (i / weeklyTickCount) * 100)
                            return (
                              <div className="project-gantt">
                                <div className="gantt-header">
                                  <span className="gantt-header-spacer" />
                                  <div className="gantt-header-track">
                                    <span className="gantt-start"><span className="gantt-edge-line gantt-edge-line-start" />{formatMonthDayFromDate(ganttRange.start)}</span>
                                    <span className="gantt-end">{formatMonthDayFromDate(ganttRange.end)}<span className="gantt-edge-line gantt-edge-line-end" /></span>
                                  </div>
                                </div>
                                <div className="gantt-container">
                                  <div
                                    className="gantt-bars"
                                    style={todayPosition !== null ? ({ ['--today-pos' as any]: `${todayPosition / 100}` } as any) : undefined}
                                  >
                                    <div className="gantt-weekly-grid">
                                      {weeklyTickPositions.map((left, i) => (
                                        <span key={i} className="gantt-weekly-tick" style={{ left: `${left}%` }} />
                                      ))}
                                    </div>
                                    {todayPosition !== null && (
                                      <div className="gantt-today-global">
                                        <span className="gantt-today-label">Today</span>
                                      </div>
                                    )}
                                    {project.timeline && project.timeline.length > 0 ? (
                                      project.timeline.map((range: any, idx: number) => (
                                        <div key={range.id} className="gantt-track">
                                          <span className="gantt-track-label" title={range.name}>{range.name}</span>
                                          <div className="gantt-track-bars">
                                            <div
                                              className={`gantt-bar bar-${(idx % 5) + 1}`}
                                              style={getGanttBarStyle(range, ganttRange)}
                                              title={`${range.name}: ${formatMonthDay(range.startDate)} → ${formatMonthDay(range.endDate)} · ${calcRangeHours(range.startDate, range.endDate)} hrs`}
                                            >
                                              <span className="gantt-label">{formatMonthDay(range.startDate)} <span className="gantt-arrow">→</span> {formatMonthDay(range.endDate)} · {calcRangeHours(range.startDate, range.endDate)}h</span>
                                            </div>
                                          </div>
                                        </div>
                                      ))
                                    ) : project.startDate && project.endDate ? (
                                      <div className="gantt-track">
                                        <span className="gantt-track-label" title="Duration">Duration</span>
                                        <div className="gantt-track-bars">
                                          <div
                                            className="gantt-bar bar-duration"
                                            style={getGanttBarStyle({ id: 'duration', name: 'Duration', startDate: project.startDate, endDate: project.endDate }, ganttRange)}
                                            title={`Duration: ${formatMonthDay(project.startDate)} → ${formatMonthDay(project.endDate)}`}
                                          >
                                            <span className="gantt-label">{formatMonthDay(project.startDate)} <span className="gantt-arrow">→</span> {formatMonthDay(project.endDate)}</span>
                                          </div>
                                        </div>
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            )
                          })()}
                        <div className="project-card-footer">
                          <div className="project-links-footer">
                            {(() => {
                              const footerLinks: React.ReactNode[] = []
                              if (project.deckLink) footerLinks.push(<a key="deck" href={project.deckLink} target="_blank" rel="noopener noreferrer" className="project-footer-link"><Presentation size={12} /><span>{project.deckName || 'Design Deck'}</span></a>)
                              if (project.prdLink) footerLinks.push(<a key="prd" href={project.prdLink} target="_blank" rel="noopener noreferrer" className="project-footer-link"><FileText size={12} /><span>{project.prdName || 'PRD'}</span></a>)
                              if (project.briefLink) footerLinks.push(<a key="brief" href={project.briefLink} target="_blank" rel="noopener noreferrer" className="project-footer-link"><FileEdit size={12} /><span>{project.briefName || 'Design Brief'}</span></a>)
                              if (project.figmaLink) footerLinks.push(<a key="figma" href={project.figmaLink} target="_blank" rel="noopener noreferrer" className="project-footer-link"><Figma size={12} /><span>Figma</span></a>)
                              if (project.customLinks) project.customLinks.forEach((link: any, idx: number) => {
                                footerLinks.push(<a key={`cl-${idx}`} href={link.url} target="_blank" rel="noopener noreferrer" className="project-footer-link"><LinkIcon size={12} /><span>{link.name}</span></a>)
                              })
                              return footerLinks.map((node, i) => (
                                <span key={i} className="project-footer-link-wrap">
                                  {i > 0 && <span className="project-link-sep">·</span>}
                                  {node}
                                </span>
                              ))
                            })()}
                          </div>
                        </div>
                        {/* Weekly Update Inline */}
                        {currentWeek && (() => {
                          const projectUpdates = weeklyUpdates.filter(u => u.project_id === project.id)
                          const assignedDesignerNames = project.designers || []
                          const primaryDesigner = team.find(t => assignedDesignerNames.includes(t.name))
                          const designerId = primaryDesigner?.id || project.id
                          return (
                            <WeeklyUpdateForm
                              project={project}
                              projectUpdates={projectUpdates}
                              weeklyGeneral={weeklyGeneral}
                              designerId={designerId}
                              isExpanded={weeklyExpandedProject === project.id}
                              onToggle={() => setWeeklyExpandedProject(prev => prev === project.id ? null : project.id)}
                              onSave={async (data) => {
                                if (data.highlight.trim()) {
                                  await saveWeeklyUpdate({ ...(data.existingHighlight ? { id: data.existingHighlight.id } : {}), project_id: project.id, designer_id: designerId, week: currentWeek, type: 'highlight' as const, description: data.highlight.trim() })
                                } else if (data.existingHighlight) { await deleteWeeklyUpdate(data.existingHighlight.id) }
                                if (data.lowlight.trim()) {
                                  await saveWeeklyUpdate({ ...(data.existingLowlight ? { id: data.existingLowlight.id } : {}), project_id: project.id, designer_id: designerId, week: currentWeek, type: 'lowlight' as const, description: data.lowlight.trim(), risk_reason: data.risk_reason.trim(), resolution: data.resolution.trim() })
                                } else if (data.existingLowlight) { await deleteWeeklyUpdate(data.existingLowlight.id) }
                                const eFYIs = weeklyGeneral.filter(e => e.category === 'fyi' && e.designer_id === designerId)
                                for (const old of eFYIs) await deleteWeeklyGeneral(old.id)
                                if (data.fyi.trim()) { await saveWeeklyGeneral({ designer_id: designerId, week: currentWeek, category: 'fyi', content: data.fyi.trim() }) }
                                const ePeople = weeklyGeneral.filter(e => e.category === 'people' && e.designer_id === designerId)
                                for (const old of ePeople) await deleteWeeklyGeneral(old.id)
                                if (data.people.trim()) { await saveWeeklyGeneral({ designer_id: designerId, week: currentWeek, category: 'people', content: data.people.trim() }) }
                              }}
                              onAddProjectLink={async (name, url) => {
                                const existing = project.customLinks || []
                                const alreadyExists = existing.some((l: { url: string }) => l.url === url) || [project.deckLink, project.prdLink, project.briefLink, project.figmaLink].includes(url)
                                if (!alreadyExists) {
                                  const updated = { ...project, customLinks: [...existing, { name, url }] }
                                  await saveProject(updated)
                                  setProjects(projects.map(p => p.id === project.id ? updated : p))
                                }
                              }}
                            />
                          )
                        })()}
                        {(() => {
                          const imgs = allProjectImages.filter(i => i.project_id === project.id)
                          if (imgs.length === 0) return null
                          return (
                            <div className="project-attached-images">
                              <span className="project-attached-label">Attached images</span>
                              <div className="project-images-inline">
                                {imgs.slice(0, 4).map((img, idx) => (
                                  <div key={img.id} className="project-image-thumb">
                                    <img src={`/api/images/${img.id}`} alt={img.caption || img.original_name} loading="lazy"
                                      onClick={() => setLightbox({ images: imgs, index: idx })} />
                                  </div>
                                ))}
                                {imgs.length > 4 && <span className="project-card-images">+{imgs.length - 4} more</span>}
                              </div>
                            </div>
                          )
                        })()}
                      </div>
                    )
                  }

                  // Flat list for dueDate sort — no grouping
                  if (projectSortBy === 'dueDate') {
                    return <div className="list-bl-section">
                      {filteredProjects.map(project => renderProjectRow(project))}
                    </div>
                  }

                  // Grouped by business line for all other sorts
                  const groups: { name: string; projects: typeof filteredProjects }[] = []
                  const blOrder = businessLines.map(bl => bl.name)
                  const grouped = new Map<string, typeof filteredProjects>()
                  for (const p of filteredProjects) {
                    const blNames = p.businessLines && p.businessLines.length > 0 ? p.businessLines : ['Uncategorized']
                    for (const bl of blNames) {
                      if (!grouped.has(bl)) grouped.set(bl, [])
                      grouped.get(bl)!.push(p)
                    }
                  }
                  for (const blName of blOrder) {
                    if (grouped.has(blName)) {
                      groups.push({ name: blName, projects: grouped.get(blName)! })
                      grouped.delete(blName)
                    }
                  }
                  for (const [name, projects] of grouped) {
                    groups.push({ name, projects })
                  }

                  return groups.map(group => (
                    <div key={group.name} className="list-bl-section">
                      <div className="list-bl-header">{group.name}</div>
                      {group.projects.map(project => renderProjectRow(project))}
                    </div>
                  ))
                })()}
              </div>}

              {/* Priority View */}
              {!showArchive && projectViewMode === 'priority' && (() => {
                const selectedBlId = priorityBusinessLine || 'all'
                const isAllView = selectedBlId === 'all'
                const liveStatuses = ['active', 'blocked', 'review']

                // Helper: render a single business line's priority section
                const renderBlSection = (blId: string, bl: BusinessLine, doneZoneId: string, inProgressZoneId?: string) => {
                  const ipZoneId = inProgressZoneId || `ip-zone-${blId}`
                  const blProjects = currentProjects.filter(p => {
                    const lines = Array.isArray(p.businessLines) ? p.businessLines : (p.businessLines ? [p.businessLines] : [])
                    return lines.some(l => l === bl.name)
                  })
                  const liveProjects = blProjects.filter(p => liveStatuses.includes(p.status))
                  const doneProjects = blProjects.filter(p => p.status === 'done')
                  const savedRankedIds = (priorities[blId] || []).filter(id => liveProjects.some(p => p.id === id))
                  const unrankedLiveIds = liveProjects
                    .filter(p => !savedRankedIds.includes(p.id))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(p => p.id)
                  const allRankedIds = [...savedRankedIds, ...unrankedLiveIds]
                  const ranked = allRankedIds.map(id => liveProjects.find(p => p.id === id)).filter(Boolean) as Project[]
                  const doneSorted = doneProjects.sort((a, b) => a.name.localeCompare(b.name))
                  const doneItemIds = doneSorted.map(p => `done:${p.id}`)

                  if (blProjects.length === 0 && isAllView) return null

                  return (
                    <div key={blId} className={isAllView ? 'priority-bl-section' : undefined}>
                      {isAllView && <div className="priority-bl-header">{bl.name}</div>}
                      {blProjects.length === 0 ? (
                        <div className="priority-empty">No projects in {bl.name}</div>
                      ) : (
                        <DndContext
                          sensors={prioritySensors}
                          collisionDetection={closestCenter}
                          onDragStart={(e: DragStartEvent) => {
                            const activeStr = String(e.active.id)
                            const id = activeStr.replace('done:', '')
                            const proj = projects.find(p => p.id === id) || null
                            setActiveDragProject(proj)
                            setIsDraggingFromDone(activeStr.startsWith('done:'))
                          }}
                          onDragCancel={() => { setActiveDragProject(null); setIsDraggingFromDone(false) }}
                          onDragEnd={(e: DragEndEvent) => {
                            setActiveDragProject(null)
                            setIsDraggingFromDone(false)
                            const { active, over } = e
                            if (!over) return
                            const activeStr = String(active.id)
                            const overStr = String(over.id)

                            // Dragging a done project back to live list
                            if (activeStr.startsWith('done:')) {
                              // Ignore if dropped back in the done zone or on another done item
                              if (overStr === doneZoneId || overStr.startsWith('done:')) {
                                return
                              }
                              const projectId = activeStr.replace('done:', '')
                              // Dropped on in-progress zone (empty list) or a live item
                              if (overStr === ipZoneId) {
                                markProjectUndone(projectId, blId, allRankedIds, 0)
                                
                                return
                              }
                              // Determine insert position: if dropped on a live item, insert at its index; otherwise append
                              const overIndex = allRankedIds.indexOf(overStr)
                              const insertIndex = overIndex !== -1 ? overIndex : allRankedIds.length
                              markProjectUndone(projectId, blId, allRankedIds, insertIndex)
                              
                              return
                            }

                            // Dragging a live project to done zone
                            if (overStr === doneZoneId) {
                              markProjectDone(activeStr, blId, allRankedIds)
                              
                              return
                            }
                            if (active.id === over.id) return
                            const oldIndex = allRankedIds.indexOf(activeStr)
                            const newIndex = allRankedIds.indexOf(overStr)
                            if (oldIndex === -1 || newIndex === -1) return
                            savePriorities(blId, arrayMove(allRankedIds, oldIndex, newIndex))
                          }}
                        >
                          {/* In Progress zone — droppable so done items can return even when empty */}
                          <SortableContext items={allRankedIds} strategy={verticalListSortingStrategy}>
                            <InProgressDropZone id={ipZoneId} isDraggingFromDone={isDraggingFromDone}>
                                {ranked.map((p, i) => (
                                  <SortablePriorityItem key={p.id} project={p} rank={i + 1} />
                                ))}
                            </InProgressDropZone>
                          </SortableContext>

                          {/* Done zone - separate context so items don't visually cross zones */}
                          <SortableContext items={doneItemIds} strategy={verticalListSortingStrategy}>
                            <DoneDropZone id={doneZoneId}>
                              {doneSorted.map(p => (
                                <SortableDoneItem key={p.id} project={p} />
                              ))}
                            </DoneDropZone>
                          </SortableContext>

                          {/* Drag overlay for cross-zone dragging */}
                          <DragOverlay>
                            {activeDragProject ? (
                              <div className="priority-item drag-overlay">
                                <button type="button" className="action-btn drag-handle"><GripVertical size={14} /></button>
                                <span className="priority-rank">—</span>
                                <div className="priority-info">
                                  <span className="priority-name">{activeDragProject.name}</span>
                                  <span className="priority-meta">{activeDragProject.designers?.join(', ') || '—'}</span>
                                </div>
                                <span className="priority-status-label">
                                  <span className="priority-status-dot" />
                                  Done
                                </span>
                              </div>
                            ) : null}
                          </DragOverlay>
                        </DndContext>
                      )}
                    </div>
                  )
                }

                if (isAllView) {
                  // Filter to business lines that have projects
                  const blsWithProjects = businessLines.filter(bl =>
                    projects.some(p => {
                      const lines = Array.isArray(p.businessLines) ? p.businessLines : (p.businessLines ? [p.businessLines] : [])
                      return lines.some(l => l === bl.name)
                    })
                  )
                  return (
                    <div className="priority-view">
                      {blsWithProjects.length === 0 ? (
                        <div className="priority-empty">No projects found</div>
                      ) : (
                        blsWithProjects.map(bl => renderBlSection(bl.id, bl, `done-drop-zone-${bl.id}`))
                      )}
                    </div>
                  )
                } else {
                  const bl = businessLines.find(b => b.id === selectedBlId)
                  if (!bl) return <div className="priority-view"><div className="priority-empty">Business line not found</div></div>
                  return (
                    <div className="priority-view">
                      {renderBlSection(selectedBlId, bl, 'done-drop-zone')}
                    </div>
                  )
                }
              })()}


            </div>
          )}

          {activeTab === 'team' && (
            <div className="team-grid">
              <div className="team-list">
                {sortedTeam.map(member => (
                  <div key={member.id} className="team-card">
                    <div className="member-info">
                      <div className="member-info-left">
                        <span className="member-name">{member.name}</span>
                        <span className="member-role">{member.role}</span>
                        {(() => {
                          const businessLines = getMemberBusinessLines(member)
                          if (businessLines.length === 0) return null
                          return (
                            <span className="member-business-line">
                              {businessLines.map(({ brand, isManual }) => (
                                <span 
                                  key={brand} 
                                  className={`business-line-item ${isManual ? 'glow' : 'muted'}`}
                                >
                                  {brand}
                                </span>
                              ))}
                            </span>
                          )
                        })()}
                      </div>
                      {(() => {
                        const upcoming = getUpcomingTimeOff(member.timeOff || [])
                        if (upcoming) {
                          return (
                            <Tooltip content={`${upcoming.name} starts ${formatShortDate(member.timeOff?.find(t => t.name === upcoming.name)?.startDate || '')}`}>
                              <span className="status-countdown">🌴 in {upcoming.days}d</span>
                            </Tooltip>
                          )
                        }
                        if (member.status === 'away') {
                          return (
                            <Tooltip content={(() => {
                              const closest = getClosestTimeOff(member.timeOff || [])
                              if (closest) {
                                return `${closest.name}: ${closest.isStart ? 'Starts' : 'Ends'} ${formatShortDate(closest.date)}`
                              }
                              return 'Away'
                            })()}>
                              <span className="status-emoji">🌴</span>
                            </Tooltip>
                          )
                        }
                        return null
                      })()}
                    </div>
                    <div className="team-card-footer">
                      <div className="member-links">
                        {member.slack ? (
                          <Tooltip content="Slack">
                            <a 
                              href={member.slack} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="member-link-icon"
                            >
                              <MessageSquare size={14} />
                            </a>
                          </Tooltip>
                        ) : (
                          <Tooltip content="No Slack">
                            <span className="member-link-icon disabled">
                              <MessageSquare size={14} />
                            </span>
                          </Tooltip>
                        )}
                        {member.email ? (
                          <Tooltip content="Email">
                            <a 
                              href={member.email.startsWith('mailto:') ? member.email : `mailto:${member.email}`} 
                              className="member-link-icon"
                            >
                              <Mail size={14} />
                            </a>
                          </Tooltip>
                        ) : (
                          <Tooltip content="No Email">
                            <span className="member-link-icon disabled">
                              <Mail size={14} />
                            </span>
                          </Tooltip>
                        )}
                      </div>
                      <div className="member-actions">
                        <button 
                          className="action-btn" 
                          onClick={() => handleEditMember(member)}
                          aria-label="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                        <button 
                          className="action-btn delete" 
                          onClick={() => handleDeleteMember(member.id)}
                          aria-label="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'calendar' && (
            <div className="calendar-view">
              {!calendarData ? (
                <div className="calendar-placeholder">
                  <Calendar size={48} strokeWidth={1.5} />
                  <h3>Loading Calendar...</h3>
                </div>
              ) : (
                <div className="calendar-container">
                  {/* Single Unified Panel - Sticky */}
                  <div className="calendar-panel">
                    {/* Panel Header - Always Visible */}
                    <div className="calendar-panel-header">
                      {/* Legend - Left */}
                      <div className="calendar-legend">
                        <div className="legend-item">
                          <span className="legend-dot" style={{ backgroundColor: '#3b82f6' }}></span>
                          <span>Project</span>
                        </div>
                        <div className="legend-item">
                          <span className="legend-dot" style={{ backgroundColor: '#ef4444' }}></span>
                          <span>Time Off</span>
                        </div>
                        <div className="legend-item">
                          <span className="legend-dot" style={{ backgroundColor: '#6b7280' }}></span>
                          <span>Special Day</span>
                        </div>
                      </div>
                      
                      {/* Filter Toggle - Right */}
                      <button 
                        className={`filter-toggle ${showFilters ? 'open' : ''}`}
                        onClick={() => setShowFilters(!showFilters)}
                        aria-expanded={showFilters}
                        aria-controls="calendar-filters-panel"
                      >
                        <ChevronDown className={`filter-toggle-icon ${showFilters ? 'open' : ''}`} size={14} />
                        Filters {calendarFilters.designers.length + calendarFilters.projects.length + calendarFilters.brands.length > 0 && `(${calendarFilters.designers.length + calendarFilters.projects.length + calendarFilters.brands.length})`}
                      </button>
                    </div>

                    {/* Panel Content - Collapsible */}
                    <div
                      id="calendar-filters-panel"
                      className={`calendar-panel-content ${showFilters ? 'open' : 'closed'}`}
                      aria-hidden={!showFilters}
                    >
                      <div className="calendar-filters">
                          {/* Designer Filter */}
                          <div className="filter-group">
                            <div className="filter-header">
                              <label>Designers</label>
                              <label className="switch">
                                <input 
                                  type="checkbox" 
                                  checked={calendarFilters.designers.length === team.length}
                                  onChange={toggleAllDesigners}
                                />
                                <span className="slider"></span>
                              </label>
                            </div>
                            <div className="filter-pills">
                              {team.map(m => (
                                <button
                                  key={m.id}
                                  className={`filter-pill designer-pill ${calendarFilters.designers.includes(m.name) ? 'active' : ''}`}
                                  onClick={() => {
                                    const newDesigners = calendarFilters.designers.includes(m.name)
                                      ? calendarFilters.designers.filter(d => d !== m.name)
                                      : [...calendarFilters.designers, m.name]
                                    setCalendarFilters({...calendarFilters, designers: newDesigners})
                                  }}
                                >
                                  {m.name}
                                </button>
                              ))}
                              {calendarFilters.designers.length > 0 && (
                                <button 
                                  className="filter-clear-pill"
                                  onClick={() => setCalendarFilters({...calendarFilters, designers: []})}
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Project Filter */}
                          <div className="filter-group">
                            <div className="filter-header">
                              <label>Projects</label>
                              <label className="switch">
                                <input 
                                  type="checkbox" 
                                  checked={calendarFilters.projects.length === projects.length}
                                  onChange={toggleAllProjects}
                                />
                                <span className="slider"></span>
                              </label>
                            </div>
                            <div className="filter-pills">
                              {projects.slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => (
                                <button
                                  key={p.id}
                                  className={`filter-pill ${calendarFilters.projects.includes(p.name) ? 'active' : ''}`}
                                  onClick={() => {
                                    const newProjects = calendarFilters.projects.includes(p.name)
                                      ? calendarFilters.projects.filter(pr => pr !== p.name)
                                      : [...calendarFilters.projects, p.name]
                                    setCalendarFilters({...calendarFilters, projects: newProjects})
                                  }}
                                >
                                  {p.name}
                                </button>
                              ))}
                              {calendarFilters.projects.length > 0 && (
                                <button 
                                  className="filter-clear-pill"
                                  onClick={() => setCalendarFilters({...calendarFilters, projects: []})}
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Brand Filter */}
                          <div className="filter-group">
                            <div className="filter-header">
                              <label>Brands</label>
                              <label className="switch">
                                <input 
                                  type="checkbox" 
                                  checked={calendarFilters.brands.length === brandOptions.length}
                                  onChange={toggleAllBrands}
                                />
                                <span className="slider"></span>
                              </label>
                            </div>
                            <div className="filter-pills">
                              {brandOptions.map(b => (
                                <button
                                  key={b}
                                  className={`filter-pill ${calendarFilters.brands.includes(b) ? 'active' : ''}`}
                                  onClick={() => {
                                    const newBrands = calendarFilters.brands.includes(b)
                                      ? calendarFilters.brands.filter(br => br !== b)
                                      : [...calendarFilters.brands, b]
                                    setCalendarFilters({...calendarFilters, brands: newBrands})
                                  }}
                                >
                                  {b}
                                </button>
                              ))}
                              {calendarFilters.brands.length > 0 && (
                                <button 
                                  className="filter-clear-pill"
                                  onClick={() => setCalendarFilters({...calendarFilters, brands: []})}
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                  {calendarData.months.map((month: CalendarMonth, mIdx: number) => {
                    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
                    const firstDayIdx = month.days[0] ? dayNames.indexOf(month.days[0].dayName) : 0

                    // Build flat cell array: empty slots + real days (no weekend filtering)
                    type CellData = { type: 'empty' } | { type: 'day'; day: CalendarDay; dayEvents: CalendarEvent[] }
                    const cells: CellData[] = []
                    for (let i = 0; i < firstDayIdx; i++) cells.push({ type: 'empty' })
                    month.days.forEach(day => {
                      cells.push({ type: 'day', day, dayEvents: filterCalendarEvents(day.events) })
                    })
                    while (cells.length % 7 !== 0) cells.push({ type: 'empty' })

                    // Split into week rows
                    const weeks: CellData[][] = []
                    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

                    const eventKey = (e: CalendarEvent) => `${e.type}-${e.name}-${e.startDate}-${e.endDate}-${e.person || ''}-${e.projectName || ''}`

                    return (
                    <div key={mIdx} className="calendar-month" data-month={`${month.year}-${month.month}`}>
                      <h3 className="month-title">
                        {month.name} <span className="month-fiscal">({getDjFiscalLabel(month.month, month.year)})</span>
                      </h3>
                      <div className="month-grid">
                        <div className="day-headers">
                          {dayNames.map(d => (
                            <div key={d} className="day-header">{d}</div>
                          ))}
                        </div>
                        {weeks.map((week, wIdx) => {
                          // Collect spanning events for this week
                          const spanEvents: { event: CalendarEvent; startCol: number; endCol: number; key: string }[] = []
                          const seenKeys = new Set<string>()

                          week.forEach((cell, colIdx) => {
                            if (cell.type !== 'day') return
                            cell.dayEvents.forEach(ev => {
                              const k = eventKey(ev)
                              if (seenKeys.has(k)) return
                              seenKeys.add(k)
                              let endCol = colIdx
                              if (ev.startDate && ev.endDate && ev.startDate !== ev.endDate) {
                                for (let c = colIdx + 1; c < 7; c++) {
                                  const nextCell = week[c]
                                  if (nextCell.type !== 'day') break
                                  if (nextCell.dayEvents.some(e2 => eventKey(e2) === k)) endCol = c
                                  else break
                                }
                              }
                              spanEvents.push({ event: ev, startCol: colIdx, endCol, key: k })
                            })
                          })

                          // Assign rows (greedy packing, longer spans first)
                          const eventRows: { event: CalendarEvent; startCol: number; endCol: number; row: number; key: string }[] = []
                          const rowOccupied: number[][] = []
                          spanEvents.sort((a, b) => (b.endCol - b.startCol) - (a.endCol - a.startCol))
                          spanEvents.forEach(se => {
                            let row = 0
                            while (true) {
                              if (!rowOccupied[row]) rowOccupied[row] = []
                              if (!rowOccupied[row].some(c => c >= se.startCol && c <= se.endCol)) break
                              row++
                              if (row > 5) break
                            }
                            for (let c = se.startCol; c <= se.endCol; c++) {
                              if (!rowOccupied[row]) rowOccupied[row] = []
                              rowOccupied[row].push(c)
                            }
                            eventRows.push({ ...se, row })
                          })

                          const maxEventRows = Math.max(0, ...eventRows.map(e => e.row + 1))
                          const EVENT_H = 20
                          const DATE_H = 24
                          const cellMinH = Math.max(80, DATE_H + maxEventRows * EVENT_H + 4)

                          return (
                          <div key={wIdx} className="week-row" style={{ position: 'relative' }}>
                            <div className="week-cells">
                              {week.map((cell, colIdx) => {
                                if (cell.type === 'empty') return <div key={colIdx} className="day-cell empty" style={{ minHeight: cellMinH }} />
                                const isToday = cell.day.date === getTodayStr()
                                const hasEvents = cell.dayEvents.length > 0
                                return (
                                  <div
                                    key={colIdx}
                                    className={`day-cell ${hasEvents ? 'has-events' : ''} ${isToday ? 'today' : ''}`}
                                    style={{ minHeight: cellMinH }}
                                    onClick={() => handleCalendarDateClick(cell.day.date, cell.dayEvents, cell.day.dayName)}
                                  >
                                    <span className="day-number">{isToday ? '★ ' : ''}{cell.day.day}</span>
                                  </div>
                                )
                              })}
                            </div>
                            {/* Event bars overlaid inside cells, below date numbers */}
                            <div className="week-events-overlay" style={{ top: `${DATE_H}px` }}>
                              {eventRows.map((er, eIdx) => {
                                const isMultiDay = er.startCol !== er.endCol
                                const isStart = !er.event.startDate || (() => {
                                  const cell = week[er.startCol]
                                  return cell.type === 'day' && cell.day.date === er.event.startDate
                                })()
                                const isEnd = !er.event.endDate || (() => {
                                  const cell = week[er.endCol]
                                  return cell.type === 'day' && cell.day.date === er.event.endDate
                                })()
                                const span = er.endCol - er.startCol + 1
                                // Project and timeoff use same label style: just the name
                                const label = er.event.type === 'timeoff'
                                  ? `🌴 ${er.event.person || er.event.name}`
                                  : er.event.type === 'holiday'
                                  ? er.event.name
                                  : er.event.name
                                return (
                                  <div
                                    key={eIdx}
                                    className={`span-event ${er.event.type} ${isMultiDay ? 'multi-day' : ''} ${isStart ? 'span-start' : ''} ${isEnd ? 'span-end' : ''}`}
                                    style={{
                                      left: `calc(${er.startCol} * (100% / 7) + 1px)`,
                                      width: `calc(${span} * (100% / 7) - 2px)`,
                                      top: `${er.row * EVENT_H}px`,
                                      backgroundColor: er.event.color || (er.event.type === 'holiday' ? '#6b7280' : er.event.type === 'timeoff' ? '#ef4444' : '#3b82f6'),
                                    }}
                                    title={`${er.event.name}${er.event.person ? ` - ${er.event.person}` : ''}`}
                                  >
                                    <span className="span-event-text">{label}</span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                          )
                        })}
                      </div>
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
      {/* Capacity Page - inside content div */}
      {activeTab === 'capacity' && capacityData && (
        <div className="capacity-page">
          <div className="capacity-dashboard">
            {/* Summary Stats - Speedometer Style */}
            {(() => {
              const activeTeam = capacityData.team.filter((m: CapacityMember) => !excludedDesigners.has(m.id))
              const availableQuarter = activeTeam.reduce((sum: number, m: CapacityMember) => sum + (m.weekly_hours || 35) * 13, 0)
              const allocatedQuarter = activeTeam.reduce((sum: number, m: CapacityMember) => {
                const assigned = capacityData.assignments
                  .filter((a: CapacityAssignment) => {
                    if (a.designer_id !== m.id) return false
                    const proj = projects.find(p => p.name === a.project_name)
                    return !proj || (proj.status !== 'done' && proj.status !== 'blocked' && proj.status !== 'pending' && proj.status !== 'archived')
                  })
                  .reduce((s: number, a: CapacityAssignment) => s + (a.allocation_percent || 0), 0)
                return sum + ((m.weekly_hours || 35) * assigned / 100 * 13)
              }, 0)
              const pct = availableQuarter > 0 ? Math.round((allocatedQuarter / availableQuarter) * 100) : 0
              const remaining = Math.round(availableQuarter - allocatedQuarter)
              
              const getGaugeColor = () => {
                if (pct > 100) return 'var(--color-danger, #ef4444)'
                if (pct > 85) return 'var(--color-warning, #f59e0b)'
                return 'var(--color-success, #22c55e)'
              }
              
              return (
                <div className="capacity-gauge-container">
                  <div className="gauge-section gauge-utilization">
                    <div className="capacity-gauge">
                      <svg viewBox="0 0 200 120" className="gauge-svg">
                        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="var(--color-border)" strokeWidth="12" strokeLinecap="round" />
                        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke={getGaugeColor()} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(pct / 100) * 251.2} 251.2`} style={{ transition: 'stroke-dasharray 0.5s ease' }} />
                      </svg>
                      <div className="gauge-center">
                        <span className="gauge-pct" style={{ color: getGaugeColor() }}>{pct}%</span>
                        <span className="gauge-label">Utilized</span>
                      </div>
                    </div>
                    <div className="gauge-stats-row">
                      <div className="gauge-stat">
                        <span className="gauge-stat-value">{Math.round(allocatedQuarter).toLocaleString()}</span>
                        <span className="gauge-stat-label">Allocated</span>
                      </div>
                      <div className="gauge-stat">
                        <span className="gauge-stat-value">{Math.round(availableQuarter).toLocaleString()}</span>
                        <span className="gauge-stat-label">Available</span>
                      </div>
                      <div className="gauge-stat">
                        <span className="gauge-stat-value" style={{ color: remaining < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>{remaining.toLocaleString()}</span>
                        <span className="gauge-stat-label">Remaining</span>
                      </div>
                    </div>
                  </div>
                  <div className="gauge-section gauge-fy">
                    <div className="gauge-panel-header">Fiscal Year</div>
                    <div className="fy-timeline">
                      {(() => {
                        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
                        const quarters = [
                          { label: 'Q3 FY26', start: new Date(2026, 0, 1), end: new Date(2026, 3, 1), months: [0, 1, 2] },
                          { label: 'Q4 FY26', start: new Date(2026, 3, 1), end: new Date(2026, 6, 1), months: [3, 4, 5] },
                          { label: 'Q1 FY27', start: new Date(2026, 6, 1), end: new Date(2026, 9, 1), months: [6, 7, 8] },
                          { label: 'Q2 FY27', start: new Date(2026, 9, 1), end: new Date(2027, 0, 1), months: [9, 10, 11] },
                        ]
                        const now = new Date()
                        return quarters.map(q => {
                          const qMs = q.end.getTime() - q.start.getTime()
                          const elapsed = Math.max(0, Math.min(now.getTime() - q.start.getTime(), qMs))
                          const fillPct = (elapsed / qMs) * 100
                          const isCurrent = now >= q.start && now < q.end
                          const isPast = now >= q.end
                          return (
                            <div key={q.label} className={`fy-quarter${isCurrent ? ' fy-quarter-current' : ''}`}>
                              <span className="fy-label">{q.label}</span>
                              <div className="fy-quarter-track">
                                <div className="fy-quarter-fill" style={{ width: `${isPast ? 100 : fillPct}%` }} />
                              </div>
                              <div className="fy-months">
                                {q.months.map(m => <span key={m} className="fy-month-label">{monthNames[m]}</span>)}
                              </div>
                            </div>
                          )
                        })
                      })()}
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* Quick Add Assignment */}
            <div className="capacity-quick-add">
              <span className="quick-add-label">Quick assign:</span>
              <select
                className="quick-add-select"
                value={assignmentForm.project_id}
                onChange={e => setAssignmentForm({ ...assignmentForm, project_id: e.target.value })}
              >
                <option value="">Select project</option>
                {projects.slice().sort((a, b) => a.name.localeCompare(b.name)).map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <select
                className="quick-add-select"
                value={assignmentForm.designer_id}
                onChange={e => setAssignmentForm({ ...assignmentForm, designer_id: e.target.value })}
              >
                <option value="">Designer</option>
                {capacityData.team.map(member => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
              <input
                type="number"
                className="quick-add-input"
                min={0}
                max={80}
                step={0.5}
                placeholder="hours"
                value={assignmentForm.allocation_hours || ''}
                onChange={e => setAssignmentForm({ ...assignmentForm, allocation_hours: Number(e.target.value) })}
              />
              <button className="primary-btn" onClick={saveCapacityAssignment}>Assign</button>
            </div>

            {/* Designer Filter */}
            <div className="capacity-designer-filter">
              <span className="capacity-filter-label">Filter by:</span>
              {capacityData.team.map((member: CapacityMember) => (
                <button
                  key={member.id}
                  className={`filter-pill${capacityDesignerFilter.has(member.id) ? ' active' : ''}`}
                  onClick={() => {
                    const next = new Set(capacityDesignerFilter)
                    if (next.has(member.id)) next.delete(member.id)
                    else next.add(member.id)
                    setCapacityDesignerFilter(next)
                  }}
                >
                  {member.name.split(' ')[0]}
                </button>
              ))}
              <button className="capacity-help-btn" onClick={() => setShowCapacityHelp(true)} title="How calculations work">
                <HelpCircle size={16} />
              </button>
            </div>

            {/* Designer Cards */}
            <div className="designer-cards-grid">
              {capacityData.team
                .filter((member: CapacityMember) => capacityDesignerFilter.size === 0 || capacityDesignerFilter.has(member.id))
                .map((member: CapacityMember) => {
                const memberAssignments = capacityData.assignments.filter((a: CapacityAssignment) => a.designer_id === member.id)
                const available = member.weekly_hours || 35
                const allocatedHours = memberAssignments
                  .filter((a: CapacityAssignment) => {
                    const proj = projects.find(p => p.name === a.project_name)
                    return !proj || (proj.status !== 'done' && proj.status !== 'blocked' && proj.status !== 'pending' && proj.status !== 'archived')
                  })
                  .reduce((sum: number, a: CapacityAssignment) => {
                    const allocPct = a.allocation_percent || 0
                    const allocH = parseFloat(((available * allocPct) / 100).toFixed(1))
                    const draftH = assignmentDraft[a.id] ?? allocH
                    return sum + draftH
                  }, 0)
                const utilization = available > 0 ? Math.round((allocatedHours / available) * 100) : 0
                const isOver = utilization > 100
                const getUtilColor = () => {
                  if (utilization > 100) return 'var(--color-danger, #ef4444)'
                  if (utilization > 80) return 'var(--color-warning, #f59e0b)'
                  return 'var(--color-success, #22c55e)'
                }

                return (
                  <div key={member.id} className={`designer-expandable-card ${isOver ? 'over-capacity' : ''} ${excludedDesigners.has(member.id) ? 'excluded' : ''}`}>
                    <div className="designer-card-header">
                      <div className="designer-col-info">
                        <span className="designer-name">
                          <span className="first-name">{member.name.split(' ')[0]}</span>
                          {member.name.includes(' ') && (
                            <span className="last-name">{member.name.split(' ').slice(1).join(' ')}</span>
                          )}
                        </span>
                        <span className="designer-hours">{memberAssignments.filter((a: CapacityAssignment) => { const proj = projects.find(p => p.name === a.project_name); return !proj || (proj.status !== 'done' && proj.status !== 'pending' && proj.status !== 'archived') }).length} projects</span>
                      </div>
                      <div className="designer-mini-gauge">
                        <svg viewBox="0 0 80 50" className="mini-gauge-svg">
                          <path d="M 8 42 A 32 32 0 0 1 72 42" fill="none" stroke="var(--color-border)" strokeWidth="5" strokeLinecap="round" />
                          <path d="M 8 42 A 32 32 0 0 1 72 42" fill="none" stroke={getUtilColor()} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(Math.min(utilization, 100) / 100) * 100.5} 100.5`} />
                        </svg>
                        <div className="mini-gauge-text">
                          <span className="mini-gauge-pct" style={{ color: getUtilColor() }}>{utilization}%</span>
                          <span className="mini-gauge-hours">{parseFloat(allocatedHours.toFixed(1))}h</span>
                        </div>
                      </div>
                    </div>

                    <div className="designer-card-body">
                        {/* Weekly Load Heatmap */}
                        {(() => {
                          const now = new Date()
                          const month = now.getMonth() + 1 // 1-12
                          const year = now.getFullYear()

                          // DJ fiscal quarters: Q1=Jul-Sep, Q2=Oct-Dec, Q3=Jan-Mar, Q4=Apr-Jun
                          let qStart: Date, qEnd: Date, qLabel: string
                          const fy = month >= 7 ? year + 1 : year
                          if (month >= 7 && month <= 9) {
                            qStart = new Date(year, 6, 1); qEnd = new Date(year, 8, 30); qLabel = `Q1-FY${String(fy).slice(-2)}`
                          } else if (month >= 10 && month <= 12) {
                            qStart = new Date(year, 9, 1); qEnd = new Date(year, 11, 31); qLabel = `Q2-FY${String(fy).slice(-2)}`
                          } else if (month >= 1 && month <= 3) {
                            qStart = new Date(year, 0, 1); qEnd = new Date(year, 2, 31); qLabel = `Q3-FY${String(fy).slice(-2)}`
                          } else {
                            qStart = new Date(year, 3, 1); qEnd = new Date(year, 5, 30); qLabel = `Q4-FY${String(fy).slice(-2)}`
                          }

                          // Build weeks from quarter start to quarter end
                          const firstMonday = new Date(qStart)
                          const fmDay = (firstMonday.getDay() + 6) % 7
                          firstMonday.setDate(firstMonday.getDate() - fmDay)
                          firstMonday.setHours(0, 0, 0, 0)

                          const weeks: { start: Date; end: Date }[] = []
                          const cursor = new Date(firstMonday)
                          while (cursor <= qEnd) {
                            const weekStart = new Date(cursor)
                            const weekEnd = new Date(cursor)
                            weekEnd.setDate(cursor.getDate() + 4)
                            weeks.push({ start: weekStart, end: weekEnd })
                            cursor.setDate(cursor.getDate() + 7)
                          }

                          // Which week index is the current week?
                          const todayMonday = new Date(now)
                          const todayOffset = (todayMonday.getDay() + 6) % 7
                          todayMonday.setDate(now.getDate() - todayOffset)
                          todayMonday.setHours(0, 0, 0, 0)
                          const currentWeekIdx = weeks.findIndex(w => w.start.getTime() === todayMonday.getTime())

                          const weekLoads = weeks.map(week => {
                            let hours = 0
                            let endingProjects = 0
                            for (const a of memberAssignments) {
                              const proj = projects.find(p => p.name === a.project_name)
                              if (!proj || proj.status === 'done' || proj.status === 'blocked' || proj.status === 'pending' || proj.status === 'archived') continue
                              const pStart = proj.startDate ? parseLocalDate(proj.startDate) : null
                              const pEnd = proj.endDate ? parseLocalDate(proj.endDate) : null
                              let overlaps = false
                              if (proj.timeline && proj.timeline.length > 0) {
                                for (const r of proj.timeline) {
                                  const rStart = parseLocalDate(r.startDate)
                                  const rEnd = parseLocalDate(r.endDate)
                                  if (rStart && rEnd && rStart <= week.end && rEnd >= week.start) { overlaps = true; break }
                                }
                              } else if (pStart && pEnd) {
                                overlaps = pStart <= week.end && pEnd >= week.start
                              } else {
                                overlaps = true
                              }
                              if (overlaps) {
                                const allocPct = a.allocation_percent || 0
                                hours += parseFloat(((available * allocPct) / 100).toFixed(1))
                              }
                              if (pEnd && pEnd >= week.start && pEnd <= week.end) endingProjects++
                            }
                            return { hours, endingProjects, pct: available > 0 ? Math.round((hours / available) * 100) : 0 }
                          })

                          const hasAnyLoad = weekLoads.some(w => w.hours > 0)
                          if (!hasAnyLoad) return null

                          const getWeekColor = (pct: number) => {
                            if (pct === 0) return 'var(--color-bg-primary)'
                            if (pct <= 60) return '#22c55e'
                            if (pct <= 80) return '#86efac'
                            if (pct <= 100) return '#f59e0b'
                            return '#ef4444'
                          }

                          return (
                            <div className="load-heatmap">
                              <div className="load-heatmap-label">{qLabel} load</div>
                              <div className="load-heatmap-weeks">
                                {weekLoads.map((w, i) => {
                                  const weekDate = weeks[i].start
                                  const label = weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                                  const isCurrentWeek = i === currentWeekIdx
                                  return (
                                    <div
                                      key={i}
                                      className={`load-week${isCurrentWeek ? ' load-week-current' : ''}${w.endingProjects > 0 ? ' load-week-ending' : ''}`}
                                      title={`${label}: ${w.hours}h / ${available}h (${w.pct}%)${w.endingProjects > 0 ? ` · ${w.endingProjects} ending` : ''}`}
                                    >
                                      <div
                                        className="load-week-fill"
                                        style={{ height: `${Math.min(w.pct, 120)}%`, backgroundColor: getWeekColor(w.pct) }}
                                      />
                                      {w.endingProjects > 0 && <span className="load-week-dot" />}
                                    </div>
                                  )
                                })}
                              </div>
                              <div className="load-heatmap-axis">
                                {(() => {
                                  // Build month spans: each month gets flex weight = number of weeks it covers
                                  const monthSpans: { label: string; weeks: number }[] = []
                                  let prevMonth = -1
                                  for (let i = 0; i < weeks.length; i++) {
                                    const m = weeks[i].start.getMonth()
                                    if (m !== prevMonth) {
                                      monthSpans.push({ label: weeks[i].start.toLocaleDateString('en-US', { month: 'short' }), weeks: 1 })
                                      prevMonth = m
                                    } else {
                                      monthSpans[monthSpans.length - 1].weeks++
                                    }
                                  }
                                  return monthSpans.map((m, i) => (
                                    <span key={i} className="load-heatmap-month" style={{ flex: m.weeks }}>{m.label}</span>
                                  ))
                                })()}
                              </div>
                            </div>
                          )
                        })()}

                        {memberAssignments.length === 0 ? (
                          <div className="no-assignments">No projects assigned</div>
                        ) : (() => {
                          const activeAssignments = memberAssignments.filter((a: CapacityAssignment) => {
                            const proj = projects.find(p => p.name === a.project_name)
                            return !proj || (proj.status !== 'done' && proj.status !== 'blocked' && proj.status !== 'review' && proj.status !== 'pending' && proj.status !== 'archived')
                          })
                          // Sort active assignments by force ranking (best rank across all business lines), then alphabetical
                          activeAssignments.sort((a, b) => {
                            const getBestRank = (assignment: CapacityAssignment) => {
                              let best = Infinity
                              for (const blId in priorities) {
                                const idx = priorities[blId].indexOf(assignment.project_id)
                                if (idx !== -1 && idx + 1 < best) best = idx + 1
                              }
                              return best
                            }
                            const rankA = getBestRank(a)
                            const rankB = getBestRank(b)
                            if (rankA !== rankB) return rankA - rankB
                            return (a.project_name || '').localeCompare(b.project_name || '')
                          })
                          const reviewAssignments = memberAssignments.filter((a: CapacityAssignment) => {
                            const proj = projects.find(p => p.name === a.project_name)
                            return proj?.status === 'review'
                          })
                          const blockedAssignments = memberAssignments.filter((a: CapacityAssignment) => {
                            const proj = projects.find(p => p.name === a.project_name)
                            return proj?.status === 'blocked'
                          })
                          const doneAssignments = memberAssignments.filter((a: CapacityAssignment) => {
                            const proj = projects.find(p => p.name === a.project_name)
                            return proj?.status === 'done'
                          })
                          const pendingAssignments = memberAssignments.filter((a: CapacityAssignment) => {
                            const proj = projects.find(p => p.name === a.project_name)
                            return proj?.status === 'pending'
                          })

                          const renderChip = (assignment: CapacityAssignment, isDone: boolean, isBlocked?: boolean, isReview?: boolean) => {
                            const allocPct = assignment.allocation_percent || 0
                            const allocHours = Math.round((available * allocPct) / 100 * 2) / 2
                            const paused = isDone || isBlocked
                            const effectiveHours = paused ? 0 : (assignmentDraft[assignment.id] ?? allocHours)
                            const proj = projects.find(p => p.name === assignment.project_name)
                            const hasTimeline = proj?.timeline && proj.timeline.length > 0
                            const timelineTotal = hasTimeline ? proj.timeline.reduce((s, r) => s + calcRangeHours(r.startDate, r.endDate), 0) : 0
                            const isOverdue = (() => {
                              if (!proj?.endDate || proj.status === 'done' || proj.status === 'pending' || proj.status === 'archived') return false
                              const end = parseLocalDate(proj.endDate)
                              if (!end) return false
                              const today = new Date()
                              today.setHours(12, 0, 0, 0)
                              return end < today
                            })()
                            return (
                              <div key={assignment.id} className={`assignment-chip${isDone ? ' chip-done' : ''}${isBlocked ? ' chip-blocked' : ''}${isReview ? ' chip-review' : ''}`}>
                                <div className="chip-header">
                                  <span
                                    className="chip-project-link"
                                    onClick={() => {
                                      setActiveTab('projects')
                                      setProjectFilters({ businessLines: [], designers: [], statuses: [], project: assignment.project_name || null })
                                      setProjectSortBy('name')
                                    }}
                                  >
                                    {isOverdue && <span className="overdue-label">Overdue</span>}{isOverdue && ' '}
                                    {assignment.project_name || 'Project'}
                                  </span>
                                  <span className="chip-hours-badge">
                                    {isBlocked ? `(${allocHours}h)` : `${effectiveHours}h`}
                                  </span>
                                  <button
                                    className="chip-delete"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      openConfirmModal('Remove assignment?', `Remove ${assignment.project_name || 'project'} from ${member.name}?`, async () => {
                                        await removeCapacityAssignment(assignment.id)
                                        closeConfirmModal()
                                      })
                                    }}
                                  >
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                                <div className="chip-slider-row">
                                  <input
                                    type="range"
                                    className="chip-slider"
                                    min={0}
                                    max={available}
                                    step={0.5}
                                    value={isBlocked ? allocHours : effectiveHours}
                                    disabled={paused}
                                    style={{
                                      background: (() => {
                                        const pctVal = available > 0 ? ((isBlocked ? allocHours : effectiveHours) / available) * 100 : 0
                                        const fillColor = pctVal <= 40 ? '#22c55e' : pctVal <= 70 ? '#f59e0b' : '#ef4444'
                                        return `linear-gradient(to right, ${fillColor} 0%, ${fillColor} ${pctVal}%, var(--color-border) ${pctVal}%, var(--color-border) 100%)`
                                      })()
                                    }}
                                    onInput={e => !paused && setAssignmentDraft({ ...assignmentDraft, [assignment.id]: Number((e.target as HTMLInputElement).value) })}
                                    onChange={() => {}}
                                    onMouseUp={(e) => {
                                      if (paused) return
                                      const newHours = Number((e.target as HTMLInputElement).value)
                                      const newPct = Math.round((newHours / available) * 100)
                                      if (newPct !== allocPct) saveAssignmentAllocation(assignment, newPct)
                                    }}
                                    onTouchEnd={(e) => {
                                      if (paused) return
                                      const newHours = Number((e.target as HTMLInputElement).value)
                                      const newPct = Math.round((newHours / available) * 100)
                                      if (newPct !== allocPct) saveAssignmentAllocation(assignment, newPct)
                                    }}
                                    onClick={e => e.stopPropagation()}
                                  />
                                </div>
                                {proj && (proj.estimatedHours || timelineTotal > 0) && (() => {
                                  const hrs = proj.estimatedHours || timelineTotal
                                  const sizeMap: Record<number, string> = { 35: 'XXS', 70: 'XS', 105: 'S', 175: 'M', 280: 'L', 455: 'XL', 910: 'XXL' }
                                  const size = sizeMap[hrs] || ''
                                  const weeks = Math.round((hrs / 35) * 10) / 10
                                  const weeksStr = weeks % 1 === 0 ? weeks.toFixed(0) : weeks.toFixed(1)
                                  return <div className="chip-est"><Clock size={10} /> {size ? `${size} · ` : ''}{hrs}h est ({weeksStr}wk)</div>
                                })()}
                                {proj && capacityData && (() => {
                                  const projAssignments = capacityData.assignments.filter(a => a.project_id === proj.id && a.project_status !== 'done' && a.project_status !== 'blocked' && a.project_status !== 'pending' && a.project_status !== 'archived')
                                  if (projAssignments.length === 0) return null
                                  const totalWeeklyHrs = projAssignments.reduce((s, a) => {
                                    const designerMember = capacityData.team.find(m => m.id === a.designer_id)
                                    const dAvail = designerMember ? (designerMember.weekly_hours ?? 35) : 35
                                    return s + Math.round((dAvail * (a.allocation_percent || 0)) / 100 * 2) / 2
                                  }, 0)
                                  const projCapacity = (proj.startDate && proj.endDate) ? calcRangeHours(proj.startDate, proj.endDate) : 0
                                  const projWeeks = projCapacity > 0 ? Math.round((projCapacity / 35) * 10) / 10 : 0
                                  const totalEffort = totalWeeklyHrs * (projWeeks || 1)
                                  const estHrs = proj.estimatedHours || timelineTotal || 0
                                  const overAllocated = estHrs > 0 && totalEffort > estHrs * 1.2
                                  const underAllocated = estHrs > 0 && projWeeks > 0 && totalEffort < estHrs * 0.5
                                  const flag = overAllocated ? 'over' : underAllocated ? 'under' : ''
                                  return (
                                    <div className={`chip-allocation-summary${flag ? ` chip-alloc-${flag}` : ''}`}>
                                      {projAssignments.length} designer{projAssignments.length > 1 ? 's' : ''} · {parseFloat(totalWeeklyHrs.toFixed(1))}h/wk{projWeeks > 0 ? ` · ${projWeeks % 1 === 0 ? projWeeks.toFixed(0) : projWeeks.toFixed(1)}wk` : ''}
                                      {flag === 'over' && ' ⚠ over-allocated'}
                                      {flag === 'under' && ' ⚠ under-allocated'}
                                    </div>
                                  )
                                })()}
                                {hasTimeline && (
                                  <div className="chip-phases">
                                    {proj.timeline.map((r: TimelineRange) => (
                                      <span key={r.id} className="chip-phase">{r.name} <span className="chip-phase-hrs">{calcRangeHours(r.startDate, r.endDate)}h</span></span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          }

                          return (
                            <>
                              {activeAssignments.length > 0 && (
                                <div className="assignment-chips">
                                  <div className="chips-column-header">
                                    <span></span>
                                    <span className="chips-column-label">Hrs/week</span>
                                  </div>
                                  {activeAssignments.map((a: CapacityAssignment) => renderChip(a, false))}
                                </div>
                              )}
                              {reviewAssignments.length > 0 && (
                                <div className="assignment-chips-review">
                                  <div className="chips-review-label">In Review</div>
                                  {reviewAssignments.map((a: CapacityAssignment) => renderChip(a, false, false, true))}
                                </div>
                              )}
                              {blockedAssignments.length > 0 && (
                                <div className="assignment-chips-blocked">
                                  <div className="chips-blocked-label">Blocked</div>
                                  {blockedAssignments.map((a: CapacityAssignment) => renderChip(a, false, true))}
                                </div>
                              )}
                              {pendingAssignments.length > 0 && (
                                <div className="assignment-chips-done">
                                  <div className="chips-done-label">Pending</div>
                                  {pendingAssignments.map((a: CapacityAssignment) => renderChip(a, true))}
                                </div>
                              )}
                              {doneAssignments.length > 0 && (
                                <div className="assignment-chips-done">
                                  <div className="chips-done-label">Done</div>
                                  {doneAssignments.map((a: CapacityAssignment) => renderChip(a, true))}
                                </div>
                              )}
                            </>
                          )
                        })()}

                        {/* Inline Add Project */}
                        <div className="inline-add">
                          <select
                            className="inline-add-select"
                            value={assignmentForm.project_id}
                            onChange={e => setAssignmentForm({ ...assignmentForm, project_id: e.target.value, designer_id: member.id })}
                          >
                            <option value="">+ Add project</option>
                            {projects
                              .slice().sort((a, b) => a.name.localeCompare(b.name))
                              .filter(p => !memberAssignments.some(a => a.project_name === p.name))
                              .map(project => (
                                <option key={project.id} value={project.id}>{project.name}</option>
                              ))
                            }
                          </select>
                          {assignmentForm.designer_id === member.id && assignmentForm.project_id && (
                            <div className="inline-add-controls">
                              <span className="chip-hours-label">{assignmentForm.allocation_hours || 0}h</span>
                              <input
                                type="range"
                                className="chip-slider"
                                min={0}
                                max={available}
                                step={0.5}
                                value={assignmentForm.allocation_hours || 0}
                                onChange={e => setAssignmentForm({ ...assignmentForm, allocation_hours: Number(e.target.value) })}
                              />
                              <button
                                className="inline-add-save"
                                onClick={async () => {
                                  await saveCapacityAssignment()
                                }}
                              >
                                Save
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Hours Edit */}
                        <div className="hours-edit">
                          <div className="hours-edit-left">
                            <label>Weekly hours:</label>
                            <input
                              type="number"
                              className="hours-edit-input"
                              min={0}
                              max={80}
                              value={hoursDraft[member.id] ?? available}
                              onChange={e => setHoursDraft({ ...hoursDraft, [member.id]: Number(e.target.value) })}
                              onBlur={(e) => {
                                const newVal = Number(e.target.value)
                                if (newVal !== available) {
                                  updateWeeklyHours(member.id, newVal)
                                }
                              }}
                            />
                          </div>
                          <div className="exclude-group">
                            <span className="exclude-label">Exclude</span>
                            <label className="switch">
                              <input
                                type="checkbox"
                                checked={excludedDesigners.has(member.id)}
                                onChange={(e) => {
                                  const newExcluded = new Set(excludedDesigners)
                                  if (e.target.checked) {
                                    newExcluded.add(member.id)
                                  } else {
                                    newExcluded.delete(member.id)
                                  }
                                  setExcludedDesigners(newExcluded)
                                  updateExcludedStatus(member.id, e.target.checked)
                                }}
                              />
                              <span className="slider"></span>
                            </label>
                          </div>
                        </div>
                      </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Notes View */}
      {activeTab === 'reports' && (() => {
        const today = new Date()
        const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        const activeProjects = currentProjects.filter(p => p.status === 'active')
        const reviewProjects = currentProjects.filter(p => p.status === 'review')
        const blockedProjects = currentProjects.filter(p => p.status === 'blocked')
        const doneProjects = currentProjects.filter(p => p.status === 'done')
        const pendingProjects = currentProjects.filter(p => p.status === 'pending')
        const overdueProjects = currentProjects.filter(p => {
          if (!p.endDate || p.status === 'done' || p.status === 'pending') return false
          const end = parseLocalDate(p.endDate)
          return end ? end < today : false
        })
        const noEstimate = currentProjects.filter(p => p.status !== 'done' && p.status !== 'pending' && (!p.estimatedHours || p.estimatedHours <= 0))
        const noDesigner = currentProjects.filter(p => p.status !== 'done' && p.status !== 'pending' && (!p.designers || p.designers.length === 0))

        const openReport = (title: string, content: string, richContent?: React.ReactNode) => {
          setReportModal({ open: true, title, content, richContent })
        }

        const generateWeeklyStatus = () => {
          // Plain text for clipboard
          // Build sections from weekly update data
          const highlights = weeklyUpdates.filter(u => u.type === 'highlight')
          const lowlights = weeklyUpdates.filter(u => u.type === 'lowlight')
          const generalHighlights = weeklyGeneral.filter(e => e.category === 'highlight')
          const generalLowlights = weeklyGeneral.filter(e => e.category === 'lowlight')
          const fyis = weeklyGeneral.filter(e => e.category === 'fyi')
          const peopleUpdates = weeklyGeneral.filter(e => e.category === 'people')

          const getBrand = (u: WeeklyUpdate) => {
            if (u.business_lines) {
              try { const parsed = JSON.parse(u.business_lines); return Array.isArray(parsed) ? parsed[0] : u.business_lines } catch { return u.business_lines }
            }
            const proj = currentProjects.find(p => p.id === u.project_id)
            return proj?.businessLines?.[0] || 'General'
          }

          const highlightsText = (() => {
            const projectLines = highlights.map(u => {
              const brand = getBrand(u)
              const proj = currentProjects.find(p => p.id === u.project_id)
              const links = [
                proj?.deckLink && `[${proj.deckName || 'Deck'}](${proj.deckLink})`,
                proj?.prdLink && `[${proj.prdName || 'PRD'}](${proj.prdLink})`,
                proj?.briefLink && `[${proj.briefName || 'Brief'}](${proj.briefLink})`,
                proj?.figmaLink && `[Figma](${proj.figmaLink})`,
              ].filter(Boolean) as string[]
              const lines = [`- **${brand}: ${u.project_name || 'Unknown'}**`, `  - ${u.description}`]
              if (links.length > 0) lines.push(`  - Related: ${links.join(', ')}`)
              return lines.join('\n')
            })
            const generalLines = generalHighlights.filter(e => e.content.trim()).map(e => `- General: ${e.content.trim()}`)
            const all = [...generalLines, ...projectLines]
            return all.length > 0 ? all.join('\n') : '- TK'
          })()

          const lowlightsText = (() => {
            const projectLines = lowlights.map(u => {
              const brand = getBrand(u)
              const lines = [`- **${brand}: ${u.project_name || 'Unknown'}**`, `  - ${u.description}`]
              if (u.risk_reason) lines.push(`  - At risk: ${u.risk_reason}`)
              if (u.resolution) lines.push(`  - Path to resolution: ${u.resolution}`)
              return lines.join('\n')
            })
            const generalLines = generalLowlights.filter(e => e.content.trim()).map(e => `- General: ${e.content.trim()}`)
            const all = [...generalLines, ...projectLines]
            return all.length > 0 ? all.join('\n') : '- TK'
          })()

          const fyisText = fyis.length > 0 ? fyis.map(e => `- General: ${e.content.trim()}`).join('\n') : '- TK'
          const peopleText = peopleUpdates.length > 0 ? peopleUpdates.map(e => `- General: ${e.content.trim()}`).join('\n') : '- TK'

          const fullText = `**Design**\n**Highlights**\n${highlightsText}\n\n**Lowlights**\n${lowlightsText}\n\n**Upcoming FYIs**\n${fyisText}\n\n**People Updates**\n${peopleText}`

          const sectionCopy = (text: string) => {
            copyRichText(text).then(() => {
              setCopiedReport(Date.now())
              setTimeout(() => setCopiedReport(null), 2000)
            })
          }

          const entryTextForUpdate = (u: WeeklyUpdate, brand: string) => {
            const proj = currentProjects.find(p => p.id === u.project_id)
            const linksMd = [
              proj?.deckLink && `[${proj.deckName || 'Deck'}](${proj.deckLink})`,
              proj?.prdLink && `[${proj.prdName || 'PRD'}](${proj.prdLink})`,
              proj?.briefLink && `[${proj.briefName || 'Brief'}](${proj.briefLink})`,
              proj?.figmaLink && `[Figma](${proj.figmaLink})`,
            ].filter(Boolean) as string[]
            const lines = [`**${brand}: ${u.project_name || 'Unknown'}**`, u.description]
            if (linksMd.length > 0) lines.push(`Related: ${linksMd.join(', ')}`)
            if (u.risk_reason) lines.push(`At risk: ${u.risk_reason}`)
            if (u.resolution) lines.push(`Path to resolution: ${u.resolution}`)
            return lines.join('\n')
          }

          const renderUpdateEntry = (u: WeeklyUpdate, type: 'highlight' | 'lowlight') => {
            const brand = getBrand(u)
            const proj = currentProjects.find(p => p.id === u.project_id)
            const links = [
              proj?.deckLink && { name: proj.deckName || 'Deck', url: proj.deckLink },
              proj?.prdLink && { name: proj.prdName || 'PRD', url: proj.prdLink },
              proj?.briefLink && { name: proj.briefName || 'Brief', url: proj.briefLink },
              proj?.figmaLink && { name: 'Figma', url: proj.figmaLink },
              ...(proj?.customLinks || []),
            ].filter(Boolean) as { name: string; url: string }[]
            return (
              <div key={u.id} className={`rr-update-card rr-update-${type}`}>
                <button className="rr-copy-entry" onClick={() => sectionCopy(entryTextForUpdate(u, brand))} title="Copy entry"><ClipboardCopy size={11} /></button>
                <div className="rr-update-brand">{brand}</div>
                <div className="rr-update-project">{u.project_name || 'Unknown'}</div>
                {links.length > 0 && (
                  <div className="rr-update-links">
                    {links.map((l, i) => <span key={i}><span className="rr-link-sep">·</span><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a></span>)}
                  </div>
                )}
                <div className="rr-update-desc">{renderMarkdownLinks(u.description)}</div>
                {type === 'lowlight' && u.risk_reason && (
                  <div className="rr-update-risk"><strong>Risk:</strong> {renderMarkdownLinks(u.risk_reason)}</div>
                )}
                {type === 'lowlight' && u.resolution && (
                  <div className="rr-update-resolution"><strong>Resolution:</strong> {renderMarkdownLinks(u.resolution)}</div>
                )}
                <div className="rr-update-author">{proj?.designers && proj.designers.length > 0 ? proj.designers.map(d => d.split(' ')[0]).join(', ') : (u.designer_name || '').split(' ')[0]}</div>
              </div>
            )
          }

          const rich = (
            <div className="rr">
              <div className="rr-date">{todayStr} · {currentWeek}</div>

              {/* Highlights */}
              <div className="rr-section">
                <div className="rr-section-header-row">
                  <div className="rr-section-header" style={{ color: '#22c55e' }}>
                    <span className="rr-section-dot" style={{ background: '#22c55e' }} />
                    <span>Highlights</span>
                    <span className="rr-section-count">{highlights.length + generalHighlights.filter(e => e.content.trim()).length}</span>
                  </div>
                  <button className="rr-copy-section" onClick={() => sectionCopy(`Highlights\n${highlightsText}`)}>
                    <ClipboardCopy size={12} /> Copy
                  </button>
                </div>
                {highlights.length > 0 || generalHighlights.some(e => e.content.trim()) ? (
                  <div className="rr-update-list">
                    {generalHighlights.filter(e => e.content.trim()).map(e => (
                      <div key={e.id} className="rr-update-card rr-update-highlight">
                        <button className="rr-copy-entry" onClick={() => sectionCopy(e.content.trim())} title="Copy entry"><ClipboardCopy size={11} /></button>
                        <div className="rr-update-brand">General</div>
                        <div className="rr-update-desc">{renderMarkdownLinks(e.content)}</div>
                      </div>
                    ))}
                    {highlights.map(u => renderUpdateEntry(u, 'highlight'))}
                  </div>
                ) : (
                  <div className="rr-empty">No highlights this week.</div>
                )}
              </div>

              {/* Lowlights */}
              <div className="rr-section">
                <div className="rr-section-header-row">
                  <div className="rr-section-header" style={{ color: '#ef4444' }}>
                    <span className="rr-section-dot" style={{ background: '#ef4444' }} />
                    <span>Lowlights</span>
                    <span className="rr-section-count">{lowlights.length + generalLowlights.filter(e => e.content.trim()).length}</span>
                  </div>
                  <button className="rr-copy-section" onClick={() => sectionCopy(`Lowlights\n${lowlightsText}`)}>
                    <ClipboardCopy size={12} /> Copy
                  </button>
                </div>
                {lowlights.length > 0 || generalLowlights.some(e => e.content.trim()) ? (
                  <div className="rr-update-list">
                    {generalLowlights.filter(e => e.content.trim()).map(e => (
                      <div key={e.id} className="rr-update-card rr-update-lowlight">
                        <button className="rr-copy-entry" onClick={() => sectionCopy(e.content.trim())} title="Copy entry"><ClipboardCopy size={11} /></button>
                        <div className="rr-update-brand">General</div>
                        <div className="rr-update-desc">{renderMarkdownLinks(e.content)}</div>
                      </div>
                    ))}
                    {lowlights.map(u => renderUpdateEntry(u, 'lowlight'))}
                  </div>
                ) : (
                  <div className="rr-empty">No lowlights this week.</div>
                )}
              </div>

              {/* Upcoming FYIs */}
              <div className="rr-section">
                <div className="rr-section-header-row">
                  <div className="rr-section-header" style={{ color: '#f59e0b' }}>
                    <span className="rr-section-dot" style={{ background: '#f59e0b' }} />
                    <span>Upcoming FYIs</span>
                    <span className="rr-section-count">{fyis.filter(e => e.content.trim()).length}</span>
                  </div>
                  <button className="rr-copy-section" onClick={() => sectionCopy(`Upcoming FYIs\n${fyisText}`)}>
                    <ClipboardCopy size={12} /> Copy
                  </button>
                </div>
                {fyis.some(e => e.content.trim()) ? (
                  <div className="rr-update-list">
                    {fyis.filter(e => e.content.trim()).map(e => (
                      <div key={e.id} className="rr-update-card rr-update-fyi">
                        <button className="rr-copy-entry" onClick={() => sectionCopy(e.content.trim())} title="Copy entry"><ClipboardCopy size={11} /></button>
                        <div className="rr-update-brand">General</div>
                        <div className="rr-update-desc">{renderMarkdownLinks(e.content)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rr-empty">No FYIs this week.</div>
                )}
              </div>

              {/* People Updates */}
              <div className="rr-section">
                <div className="rr-section-header-row">
                  <div className="rr-section-header" style={{ color: '#8b5cf6' }}>
                    <span className="rr-section-dot" style={{ background: '#8b5cf6' }} />
                    <span>People Updates</span>
                    <span className="rr-section-count">{peopleUpdates.filter(e => e.content.trim()).length}</span>
                  </div>
                  <button className="rr-copy-section" onClick={() => sectionCopy(`People Updates\n${peopleText}`)}>
                    <ClipboardCopy size={12} /> Copy
                  </button>
                </div>
                {peopleUpdates.some(e => e.content.trim()) ? (
                  <div className="rr-update-list">
                    {peopleUpdates.filter(e => e.content.trim()).map(e => (
                      <div key={e.id} className="rr-update-card rr-update-people">
                        <button className="rr-copy-entry" onClick={() => sectionCopy(e.content.trim())} title="Copy entry"><ClipboardCopy size={11} /></button>
                        <div className="rr-update-brand">General</div>
                        <div className="rr-update-desc">{renderMarkdownLinks(e.content)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rr-empty">No people updates this week.</div>
                )}
              </div>
            </div>
          )

          openReport('Weekly Status', fullText, rich)
        }

        const viewSnapshot = async (snap: { id: string; week: string; generated_at: string }) => {
          try {
            const res = await authFetch(`/api/weekly-snapshots/${snap.week}`)
            const snapData = await res.json()
            const parsed = JSON.parse(snapData.data_json || '{}')
            const hl = (parsed.highlights || []) as WeeklyUpdate[]
            const ll = (parsed.lowlights || []) as WeeklyUpdate[]
            const fi = (parsed.fyis || []) as WeeklyGeneral[]
            const pu = (parsed.peopleUpdates || []) as WeeklyGeneral[]

            const snapGetBrand = (u: WeeklyUpdate) => {
              if (u.business_lines) {
                try { const p = JSON.parse(u.business_lines); return Array.isArray(p) ? p[0] : u.business_lines } catch { return u.business_lines }
              }
              return 'General'
            }

            const snapEntryText = (u: WeeklyUpdate, brand: string) => {
              const proj = currentProjects.find(p => p.id === u.project_id)
              const linksMd = [
                proj?.deckLink && `[${proj.deckName || 'Deck'}](${proj.deckLink})`,
                proj?.prdLink && `[${proj.prdName || 'PRD'}](${proj.prdLink})`,
                proj?.briefLink && `[${proj.briefName || 'Brief'}](${proj.briefLink})`,
                proj?.figmaLink && `[Figma](${proj.figmaLink})`,
              ].filter(Boolean) as string[]
              const lines = [`**${brand}: ${u.project_name || 'Unknown'}**`, u.description]
              if (linksMd.length > 0) lines.push(`Related: ${linksMd.join(', ')}`)
              if (u.risk_reason) lines.push(`At risk: ${u.risk_reason}`)
              if (u.resolution) lines.push(`Path to resolution: ${u.resolution}`)
              return lines.join('\n')
            }

            const snapSectionCopy = (text: string) => {
              copyRichText(text).then(() => {
                setCopiedReport(Date.now())
                setTimeout(() => setCopiedReport(null), 2000)
              })
            }

            const snapRenderEntry = (u: WeeklyUpdate, type: 'highlight' | 'lowlight') => {
              const brand = snapGetBrand(u)
              const proj = currentProjects.find(p => p.id === u.project_id)
              const links = [
                proj?.deckLink && { name: proj.deckName || 'Deck', url: proj.deckLink },
                proj?.prdLink && { name: proj.prdName || 'PRD', url: proj.prdLink },
                proj?.briefLink && { name: proj.briefName || 'Brief', url: proj.briefLink },
                proj?.figmaLink && { name: 'Figma', url: proj.figmaLink },
                ...(proj?.customLinks || []),
              ].filter(Boolean) as { name: string; url: string }[]
              return (
                <div key={u.id} className={`rr-update-card rr-update-${type}`}>
                  <button className="rr-copy-entry" onClick={() => snapSectionCopy(snapEntryText(u, brand))} title="Copy entry"><ClipboardCopy size={11} /></button>
                  <div className="rr-update-brand">{brand}</div>
                  <div className="rr-update-project">{u.project_name || 'Unknown'}</div>
                  {links.length > 0 && (
                    <div className="rr-update-links">
                      {links.map((l, i) => <span key={i}><span className="rr-link-sep">·</span><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a></span>)}
                    </div>
                  )}
                  <div className="rr-update-desc">{renderMarkdownLinks(u.description)}</div>
                  {type === 'lowlight' && u.risk_reason && (
                    <div className="rr-update-risk"><strong>Risk:</strong> {renderMarkdownLinks(u.risk_reason)}</div>
                  )}
                  {type === 'lowlight' && u.resolution && (
                    <div className="rr-update-resolution"><strong>Resolution:</strong> {renderMarkdownLinks(u.resolution)}</div>
                  )}
                  <div className="rr-update-author">{proj?.designers && proj.designers.length > 0 ? proj.designers.map(d => d.split(' ')[0]).join(', ') : (u.designer_name || '').split(' ')[0]}</div>
                </div>
              )
            }

            const genDate = new Date(snapData.generated_at)
            const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

            const rich = (
              <div className="rr">
                <div className="rr-date">{dateStr} · {snap.week}</div>
                {([
                  { items: hl, label: 'Highlights', color: '#22c55e', type: 'highlight' as const },
                  { items: ll, label: 'Lowlights', color: '#ef4444', type: 'lowlight' as const },
                ] as const).map(section => (
                  <div key={section.label} className="rr-section">
                    <div className="rr-section-header-row">
                      <div className="rr-section-header" style={{ color: section.color }}>
                        <span className="rr-section-dot" style={{ background: section.color }} />
                        <span>{section.label}</span>
                        <span className="rr-section-count">{section.items.length}</span>
                      </div>
                    </div>
                    {section.items.length > 0 ? (
                      <div className="rr-update-list">{section.items.map(u => snapRenderEntry(u, section.type))}</div>
                    ) : <div className="rr-empty">No {section.label.toLowerCase()} this week.</div>}
                  </div>
                ))}
                {([
                  { items: fi, label: 'Upcoming FYIs', color: '#f59e0b' },
                  { items: pu, label: 'People Updates', color: '#8b5cf6' },
                ] as const).map(section => (
                  <div key={section.label} className="rr-section">
                    <div className="rr-section-header-row">
                      <div className="rr-section-header" style={{ color: section.color }}>
                        <span className="rr-section-dot" style={{ background: section.color }} />
                        <span>{section.label}</span>
                        <span className="rr-section-count">{section.items.length}</span>
                      </div>
                    </div>
                    {section.items.length > 0 ? (
                      <div className="rr-general-list">{section.items.map((e: WeeklyGeneral) => (
                        <div key={e.id} className="rr-general-item">
                          <button className="rr-copy-entry" onClick={() => snapSectionCopy(e.content.trim())} title="Copy entry"><ClipboardCopy size={11} /></button>
                          <span>{renderMarkdownLinks(e.content)}</span>
                          <span className="rr-general-author">{(e.designer_name || '').split(' ')[0]}</span>
                        </div>
                      ))}</div>
                    ) : <div className="rr-empty">No {section.label.toLowerCase()} this week.</div>}
                  </div>
                ))}
              </div>
            )
            openReport(`Weekly Snapshot — ${snap.week}`, snapData.plain_text || '', rich)
          } catch (err) { console.error('Error loading snapshot:', err) }
        }

        const viewReviewSnapshot = async (snap: { id: string; week: string; generated_at: string }) => {
          try {
            const res = await authFetch(`/api/review-snapshots/${snap.week}`)
            const snapData = await res.json()
            const parsed = JSON.parse(snapData.data_json || '{}')
            const reviewItems = (parsed.reviewItems || []) as any[]
            const activeItems = (parsed.activeItems || []) as any[]

            // Group review items by BL
            const reviewByBL: Record<string, any[]> = {}
            for (const item of reviewItems) {
              for (const bl of (item.businessLines || ['Unassigned'])) {
                if (!reviewByBL[bl]) reviewByBL[bl] = []
                reviewByBL[bl].push(item)
              }
            }

            // Group active items by BL
            const activeByBL: Record<string, any[]> = {}
            for (const item of activeItems) {
              for (const bl of (item.businessLines || ['Unassigned'])) {
                if (!activeByBL[bl]) activeByBL[bl] = []
                activeByBL[bl].push(item)
              }
            }

            const genDate = new Date(snapData.generated_at)
            const dateStr = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

            const rich = (
              <div className="rr">
                <div className="rr-date">{dateStr} · {snap.week}</div>
                <div className="rr-subtitle">Projects selected for stakeholder and peer design review · {reviewItems.length} project{reviewItems.length !== 1 ? 's' : ''}</div>

                {Object.entries(reviewByBL).sort(([a], [b]) => a.localeCompare(b)).map(([bl, projs]) => (
                  <div key={bl} className="rr-section">
                    <div className="rr-section-header-row">
                      <div className="rr-section-header" style={{ color: '#f59e0b' }}>
                        <span className="rr-section-dot" style={{ background: '#f59e0b' }} />
                        <span>{bl}</span>
                        <span className="rr-section-count">{projs.length}</span>
                      </div>
                    </div>
                    <div className="rr-update-list">
                      {projs.map((p: any, i: number) => (
                        <div key={i} className="rr-update-card" style={{ background: 'var(--color-bg-elevated)', borderLeftColor: '#f59e0b' }}>
                          <div className="rr-update-project">{p.project_name}</div>
                          <div className="rr-update-meta-line">
                            {(p.designers || []).map((d: string, di: number) => <span key={di} className="rr-update-designers"><User size={10} /> {d}</span>)}
                            {p.sizeLabel && <span className="rr-size-pill">{p.sizeLabel}</span>}
                            {p.endDate && <span className="rr-active-due">Project end: {formatShortDate(p.endDate)}</span>}
                          </div>
                          {p.links?.length > 0 && (
                            <div className="rr-update-links">
                              {p.links.map((l: any, li: number) => <span key={li}><span className="rr-link-sep">·</span><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a></span>)}
                            </div>
                          )}
                          {p.notes && (
                            <div className="rr-update-desc" style={{ color: 'var(--color-text)' }}>
                              <span dangerouslySetInnerHTML={{ __html: p.notes }} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {reviewItems.length === 0 && <div className="rr-empty">No projects in review this week.</div>}

                <div className="rr-divider" />

                <div className="rr-section">
                  <div className="rr-section-header-row">
                    <div className="rr-section-header" style={{ color: '#3b82f6' }}>
                      <span className="rr-section-dot" style={{ background: '#3b82f6' }} />
                      <span>All Active Projects</span>
                      <span className="rr-section-count">{activeItems.length}</span>
                    </div>
                  </div>
                  {Object.entries(activeByBL).sort(([a], [b]) => a.localeCompare(b)).map(([bl, projs]) => (
                    <div key={bl} className="rr-active-group">
                      <div className="rr-active-group-label">{bl}</div>
                      {projs.map((p: any, i: number) => {
                        const sizeMap: Record<number, string> = { 35: 'XXS', 70: 'XS', 105: 'S', 175: 'M', 280: 'L', 455: 'XL', 910: 'XXL' }
                        const tshirt = sizeMap[p.estimatedHours || 0]
                        const sz = tshirt ? `${tshirt} · ${p.estimatedHours}h` : p.estimatedHours ? `${p.estimatedHours}h` : null
                        return (
                        <div key={i} className="rr-active-row">
                          <div className="rr-active-row-main">
                            <span className="rr-active-name">{p.project_name}</span>
                            {(p.designers || []).map((d: string, di: number) => <span key={di} className="rr-active-designers"><User size={10} /> {d}</span>)}
                            {sz && <span className="rr-size-pill">{sz}</span>}
                            {p.endDate && <span className="rr-active-due">Project end: {formatShortDate(p.endDate)}</span>}
                          </div>
                          {p.links?.length > 0 && (
                            <div className="rr-active-links">
                              {p.links.map((l: any, li: number) => <span key={li}><span className="rr-link-sep">·</span><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a></span>)}
                            </div>
                          )}
                        </div>
                        )
                      })}
                    </div>
                  ))}
                  {activeItems.length === 0 && <div className="rr-empty">No active projects.</div>}
                </div>
              </div>
            )
            openReport(`W&I Open Critiques — ${snap.week}`, snapData.plain_text || '', rich)
          } catch (err) { console.error('Error loading review snapshot:', err) }
        }

        const syncOpenCritsDoc = async () => {
          setOpenCritsSyncing(true)
          try {
            const resp = await authFetch('/api/reports/open-crits/sync', {
              method: 'POST',
              body: JSON.stringify({}),
            })
            const data = await resp.json()
            if (data.success) {
              window.open(data.docUrl, '_blank')
            } else {
              alert(`Sync failed: ${data.error}`)
            }
          } catch (e) {
            alert(`Sync failed: ${e}`)
          } finally {
            setOpenCritsSyncing(false)
          }
        }

        const generateProjectReview = () => {
          const statusLabels: Record<string, string> = { active: 'Active', review: 'In Review', done: 'Done', blocked: 'Blocked', pending: 'Pending', archived: 'Archived' }
          const sizeMap: Record<number, string> = { 35: 'XXS', 70: 'XS', 105: 'S', 175: 'M', 280: 'L', 455: 'XL', 910: 'XXL' }

          // Review projects grouped by BL
          const reviewProjs = currentProjects.filter(p => p.status === 'review')
          const reviewBlGroups: Record<string, Project[]> = {}
          for (const p of reviewProjs) {
            for (const bl of (p.businessLines || ['Unassigned'])) {
              if (!reviewBlGroups[bl]) reviewBlGroups[bl] = []
              reviewBlGroups[bl].push(p)
            }
          }

          // Active projects grouped by BL
          const activeProjs = currentProjects.filter(p => p.status === 'active' || p.status === 'blocked')
          const activeBlGroups: Record<string, Project[]> = {}
          for (const p of activeProjs) {
            for (const bl of (p.businessLines || ['Unassigned'])) {
              if (!activeBlGroups[bl]) activeBlGroups[bl] = []
              activeBlGroups[bl].push(p)
            }
          }

          // Review item notes from the public review site
          const reviewItemNotes: Record<string, string> = {}
          if (editingReview?.items) {
            for (const item of editingReview.items as any[]) {
              if (item.notes && item.notes.trim()) {
                reviewItemNotes[item.project_id] = item.notes.trim()
              }
            }
          }

          const getLinks = (p: Project) => [
            p.deckLink && { name: p.deckName || 'Deck', url: p.deckLink },
            p.prdLink && { name: p.prdName || 'PRD', url: p.prdLink },
            p.briefLink && { name: p.briefName || 'Brief', url: p.briefLink },
            p.figmaLink && { name: 'Figma', url: p.figmaLink },
            ...(p.customLinks || []),
          ].filter(Boolean) as { name: string; url: string }[]

          const getSizeLabel = (p: Project) => {
            const tshirt = sizeMap[p.estimatedHours || 0]
            return tshirt ? `${tshirt} · ${p.estimatedHours}h` : p.estimatedHours ? `${p.estimatedHours}h` : null
          }

          const sectionCopy = (text: string) => {
            copyRichText(text).then(() => {
              setCopiedReport(Date.now())
              setTimeout(() => setCopiedReport(null), 2000)
            })
          }

          // --- Plain text ---
          const plainLines = [
            `W&I OPEN CRITIQUES — ${todayStr}`,
            `Projects selected for stakeholder and peer design review`,
            `${reviewProjs.length} project${reviewProjs.length !== 1 ? 's' : ''} in review`,
            '',
            ...Object.entries(reviewBlGroups).sort(([a], [b]) => a.localeCompare(b)).flatMap(([bl, projs]) => [
              bl.toUpperCase(),
              ...projs.map(p => {
                const designers = (p.designers || []).map(d => d.split(' ')[0]).join(', ')
                const sz = getSizeLabel(p) || 'no estimate'
                const due = p.endDate ? formatShortDate(p.endDate) : 'no due date'
                const links = getLinks(p).map(l => l.name).join(', ')
                const rNotes = reviewItemNotes[p.id]
                const lines = [`  • ${p.name}`, `    ${designers || 'unassigned'} · ${sz} · Due: ${due}${links ? ` · ${links}` : ''}`]
                if (rNotes) lines.push(`    Notes: ${rNotes.replace(/<[^>]+>/g, '')}`)
                return lines.join('\n')
              }),
              '',
            ]),
            '─'.repeat(40),
            '',
            `ALL ACTIVE PROJECTS — ${activeProjs.length} project${activeProjs.length !== 1 ? 's' : ''}`,
            '',
            ...Object.entries(activeBlGroups).sort(([a], [b]) => a.localeCompare(b)).flatMap(([bl, projs]) => [
              bl.toUpperCase(),
              ...projs.map(p => {
                const designers = (p.designers || []).map(d => d.split(' ')[0]).join(', ')
                const status = statusLabels[p.status] || p.status
                const due = p.endDate ? formatShortDate(p.endDate) : 'no due date'
                const links = getLinks(p).map(l => l.name).join(', ')
                return `  • ${p.name} — ${status} · ${designers || 'unassigned'} · Due: ${due}${links ? ` · ${links}` : ''}`
              }),
              '',
            ]),
          ]

          // --- Rich JSX ---
          const renderReviewCard = (p: Project) => {
            const designerNames = (p.designers || []).map(d => d.split(' ')[0])
            const links = getLinks(p)
            const sizeLabel = getSizeLabel(p)
            const due = p.endDate ? formatShortDate(p.endDate) : null
            const notes = reviewItemNotes[p.id]

            return (
              <div key={p.id} className="rr-update-card" style={{ background: 'var(--color-bg-elevated)', borderLeftColor: '#f59e0b' }}>
                <div className="rr-update-project">{p.name}</div>
                <div className="rr-update-meta-line">
                  {designerNames.map((d, i) => <span key={i} className="rr-update-designers"><User size={10} /> {d}</span>)}
                  {sizeLabel && <span className="rr-size-pill">{sizeLabel}</span>}
                  {due && <span className="rr-active-due">Project end: {due}</span>}
                </div>
                {links.length > 0 && (
                  <div className="rr-update-links">
                    {links.map((l, i) => <span key={i}><span className="rr-link-sep">·</span><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a></span>)}
                  </div>
                )}
                {notes && (
                  <div className="rr-update-desc" style={{ color: 'var(--color-text)' }}>
                    <span dangerouslySetInnerHTML={{ __html: notes }} />
                  </div>
                )}
              </div>
            )
          }

          const renderActiveRow = (p: Project) => {
            const designerNames = (p.designers || []).map(d => d.split(' ')[0])
            const links = getLinks(p)
            const sizeLabel = getSizeLabel(p)
            const due = p.endDate ? formatShortDate(p.endDate) : null
            return (
              <div key={p.id} className="rr-active-row">
                <div className="rr-active-row-main">
                  <span className="rr-active-name">{p.name}</span>
                  {designerNames.map((d, i) => <span key={i} className="rr-active-designers"><User size={10} /> {d}</span>)}
                  {sizeLabel && <span className="rr-size-pill">{sizeLabel}</span>}
                  {due && <span className="rr-active-due">Project end: {due}</span>}
                </div>
                {links.length > 0 && (
                  <div className="rr-active-links">
                    {links.map((l, i) => <span key={i}><span className="rr-link-sep">·</span><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a></span>)}
                  </div>
                )}
              </div>
            )
          }

          const rich = (
            <div className="rr">
              <div className="rr-date">{todayStr}</div>
              <div className="rr-subtitle">Projects selected for stakeholder and peer design review · {reviewProjs.length} project{reviewProjs.length !== 1 ? 's' : ''}</div>

              {Object.entries(reviewBlGroups).sort(([a], [b]) => a.localeCompare(b)).map(([bl, projs]) => (
                <div key={bl} className="rr-section">
                  <div className="rr-section-header-row">
                    <div className="rr-section-header" style={{ color: '#f59e0b' }}>
                      <span className="rr-section-dot" style={{ background: '#f59e0b' }} />
                      <span>{bl}</span>
                      <span className="rr-section-count">{projs.length}</span>
                    </div>
                    <button className="rr-copy-section" onClick={() => sectionCopy(`${bl}\n${projs.map(p => `  • ${p.name}`).join('\n')}`)}>
                      <ClipboardCopy size={12} /> Copy
                    </button>
                  </div>
                  <div className="rr-update-list">{projs.map(renderReviewCard)}</div>
                </div>
              ))}

              {reviewProjs.length === 0 && (
                <div className="rr-empty">No projects currently in review.</div>
              )}

              <div className="rr-divider" />

              <div className="rr-section">
                <div className="rr-section-header-row">
                  <div className="rr-section-header" style={{ color: '#3b82f6' }}>
                    <span className="rr-section-dot" style={{ background: '#3b82f6' }} />
                    <span>All Active Projects</span>
                    <span className="rr-section-count">{activeProjs.length}</span>
                  </div>
                </div>
                {Object.entries(activeBlGroups).sort(([a], [b]) => a.localeCompare(b)).map(([bl, projs]) => (
                  <div key={bl} className="rr-active-group">
                    <div className="rr-active-group-label">{bl}</div>
                    {projs.map(renderActiveRow)}
                  </div>
                ))}
                {activeProjs.length === 0 && (
                  <div className="rr-empty">No active projects.</div>
                )}
              </div>
            </div>
          )

          openReport('W&I Open Critiques', plainLines.join('\n'), rich)
        }

        const generateCapacityStats = () => {
          const capTeam = capacityData?.team || []
          const capAssignments = capacityData?.assignments || []
          const lines = [
            `CAPACITY REPORT — ${todayStr}`,
            '',
            'DESIGNER UTILIZATION',
            ...capTeam.filter(m => !excludedDesigners.has(m.id)).map(m => {
              const available = m.weekly_hours || 35
              const assignments = capAssignments.filter(a => a.designer_id === m.id)
              const activeAssignments = assignments.filter(a => {
                const proj = projects.find(p => p.name === a.project_name)
                return !proj || (proj.status !== 'done' && proj.status !== 'blocked' && proj.status !== 'pending' && proj.status !== 'archived')
              })
              const allocatedHours = activeAssignments.reduce((sum, a) => {
                return sum + parseFloat(((available * (a.allocation_percent || 0)) / 100).toFixed(1))
              }, 0)
              const util = available > 0 ? Math.round((allocatedHours / available) * 100) : 0
              return `  ${m.name}: ${allocatedHours}h / ${available}h (${util}%) — ${activeAssignments.length} projects`
            }),
            '',
            'PROJECT FUNDING',
            ...(() => {
              const totalEstimated = activeProjects.reduce((sum, p) => sum + (p.estimatedHours || 0), 0)
              const totalAllocated = capAssignments.reduce((sum, a) => {
                const proj = projects.find(p => p.name === a.project_name)
                if (!proj || proj.status === 'done' || proj.status === 'blocked' || proj.status === 'pending' || proj.status === 'archived') return sum
                if (!proj.startDate || !proj.endDate) return sum
                const designer = capTeam.find(m => m.id === a.designer_id)
                if (!designer || excludedDesigners.has(designer.id)) return sum
                const available = designer.weekly_hours || 35
                const allocH = parseFloat(((available * (a.allocation_percent || 0)) / 100).toFixed(1))
                const start = parseLocalDate(proj.startDate)
                const end = parseLocalDate(proj.endDate)
                if (!start || !end) return sum
                const totalWeeks = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)))
                return sum + (allocH * totalWeeks)
              }, 0)
              const fundedPct = totalEstimated > 0 ? Math.round((totalAllocated / totalEstimated) * 100) : 0
              return [
                `  Estimated: ${totalEstimated} hrs across ${activeProjects.length} active projects`,
                `  Allocated: ${Math.round(totalAllocated)} hrs (allocations × full project duration)`,
                `  Funded: ${fundedPct}%`,
              ]
            })(),
            '',
            ...(blockedProjects.length > 0 ? [
              'BLOCKED (capacity paused)',
              ...blockedProjects.map(p => `  • ${p.name} — ${(p.designers || []).map(d => d.split(' ')[0]).join(', ')}`),
              '',
            ] : []),
          ]
          openReport('Capacity Report', lines.join('\n'))
        }

        const generateProjectStats = () => {
          const totalHours = projects.reduce((sum, p) => sum + (p.estimatedHours || 0), 0)
          const avgHours = projects.filter(p => p.estimatedHours && p.estimatedHours > 0).length > 0
            ? Math.round(totalHours / projects.filter(p => p.estimatedHours && p.estimatedHours > 0).length)
            : 0
          const blCounts: Record<string, number> = {}
          for (const p of projects) {
            for (const bl of (p.businessLines || ['Unassigned'])) {
              blCounts[bl] = (blCounts[bl] || 0) + 1
            }
          }
          const designerCounts: Record<string, number> = {}
          for (const p of currentProjects.filter(pr => pr.status !== 'done' && pr.status !== 'pending')) {
            for (const d of (p.designers || [])) {
              designerCounts[d] = (designerCounts[d] || 0) + 1
            }
          }
          const lines = [
            `PROJECT STATISTICS — ${todayStr}`,
            '',
            'OVERVIEW',
            `  Total: ${currentProjects.length}${archivedProjects.length > 0 ? ` (${archivedProjects.length} archived)` : ''}`,
            `  Active: ${activeProjects.length} | Review: ${reviewProjects.length} | Blocked: ${blockedProjects.length} | Pending: ${pendingProjects.length} | Done: ${doneProjects.length}`,
            `  Overdue: ${overdueProjects.length}`,
            `  Missing estimates: ${noEstimate.length} | Missing designers: ${noDesigner.length}`,
            '',
            'HOURS',
            `  Total estimated: ${totalHours} hrs (${Math.round(totalHours / 35 * 10) / 10} weeks)`,
            `  Average per project: ${avgHours} hrs`,
            '',
            'BY BUSINESS LINE',
            ...Object.entries(blCounts).sort((a, b) => b[1] - a[1]).map(([bl, count]) => `  ${bl}: ${count}`),
            '',
            'ACTIVE PROJECTS PER DESIGNER',
            ...Object.entries(designerCounts).sort((a, b) => b[1] - a[1]).map(([d, count]) => `  ${d}: ${count}`),
          ]
          openReport('Project Statistics', lines.join('\n'))
        }

        const generateQuarterReview = () => {
          const quarters = Object.keys(archivedByQuarter).sort((a, b) => b.localeCompare(a))
          if (quarters.length === 0) {
            openReport('Quarter Review', 'No archived quarters yet.')
            return
          }
          const lines: string[] = [`QUARTERLY REVIEW — ${todayStr}`, '']
          for (const q of quarters) {
            const qProjects = archivedByQuarter[q]
            const totalHours = qProjects.reduce((sum, p) => sum + (p.estimatedHours || 0), 0)
            const designerNames = [...new Set(qProjects.flatMap(p => p.designers || []))]
            const blNames = [...new Set(qProjects.flatMap(p => p.businessLines || []))]
            lines.push(
              `${q} — ${qProjects.length} project${qProjects.length !== 1 ? 's' : ''} delivered`,
              `  Hours: ${totalHours > 0 ? `${totalHours} hrs (${Math.round(totalHours / 35 * 10) / 10} weeks)` : 'no estimates'}`,
              `  Designers: ${designerNames.length > 0 ? designerNames.join(', ') : 'none'}`,
              `  Business Lines: ${blNames.length > 0 ? blNames.join(', ') : 'none'}`,
              '',
              ...qProjects.sort((a, b) => a.name.localeCompare(b.name)).map(p => {
                const designers = (p.designers || []).map(d => d.split(' ')[0]).join(', ')
                const hours = p.estimatedHours ? `${p.estimatedHours} hrs` : 'no estimate'
                const bl = (p.businessLines || []).join(', ') || 'unassigned'
                return `  • ${p.name} — ${bl} — ${designers || 'unassigned'} — ${hours}`
              }),
              '',
            )
          }
          openReport('Quarter Review', lines.join('\n'))
        }

        const totalEstimatedHours = projects.reduce((sum, p) => sum + (p.estimatedHours || 0), 0)
        const lastQuarter = (() => {
          const currentQ = getCurrentFiscalQuarter()
          const quarters = Object.keys(archivedByQuarter).filter(q => q !== currentQ).sort((a, b) => b.localeCompare(a))
          return quarters.length > 0 ? quarters[0] : null
        })()
        const lastQProjects = lastQuarter ? archivedByQuarter[lastQuarter] : []
        const lastQHours = lastQProjects.reduce((sum, p) => sum + (p.estimatedHours || 0), 0)
        const lastQDesigners = [...new Set(lastQProjects.flatMap(p => p.designers || []))]

        const reports = [
          {
            id: 'weekly-status',
            title: 'Weekly Status Update',
            description: 'Project status summary by active, review, blocked, and done. Includes designers, hours, and due dates.',
            icon: <ListChecks size={24} />,
            color: '#3b82f6',
            stats: `${activeProjects.length} active, ${reviewProjects.length} review, ${blockedProjects.length} blocked, ${pendingProjects.length} pending`,
            generate: generateWeeklyStatus,
          },
          {
            id: 'project-review',
            title: 'W&I Open Critiques',
            description: 'Projects selected for stakeholder and peer design review, plus a full active project listing.',
            icon: <Palette size={24} />,
            color: '#8b5cf6',
            stats: `${projects.filter(p => p.status === 'review').length} in review, ${projects.filter(p => p.status === 'active' || p.status === 'blocked').length} active`,
            generate: generateProjectReview,
          },
          {
            id: 'capacity-stats',
            title: 'Capacity Report',
            description: 'Per-designer utilization, project funding analysis (projected vs estimated hours), and blocked projects.',
            icon: <Gauge size={24} />,
            color: '#10b981',
            stats: `${(capacityData?.team || []).filter(m => !excludedDesigners.has(m.id)).length} designers tracked`,
            generate: generateCapacityStats,
          },
          {
            id: 'project-stats',
            title: 'Project Statistics',
            description: 'Aggregate stats: totals by status, hours, business line distribution, and per-designer project counts.',
            icon: <BarChart3 size={24} />,
            color: '#ef4444',
            stats: `${projects.length} total, ${totalEstimatedHours} hrs estimated`,
            generate: generateProjectStats,
          },
          {
            id: 'quarter-review',
            title: 'Quarter Review',
            description: lastQuarter
              ? `Summary of delivered work by quarter. Includes projects, hours, designers, and business lines.`
              : 'No completed quarters yet. Archive done projects at the end of a quarter to build history.',
            icon: <Archive size={24} />,
            color: '#6366f1',
            stats: lastQuarter
              ? `${lastQuarter}: ${lastQProjects.length} project${lastQProjects.length !== 1 ? 's' : ''} · ${lastQHours > 0 ? `${lastQHours}h` : 'no estimates'} · ${lastQDesigners.length} designer${lastQDesigners.length !== 1 ? 's' : ''}`
              : `${archivedProjects.length} archived across ${Object.keys(archivedByQuarter).length} quarter${Object.keys(archivedByQuarter).length !== 1 ? 's' : ''}`,
            generate: archivedProjects.length > 0 ? generateQuarterReview : undefined,
          },
          {
            id: 'open-crits',
            title: 'W&I Open Crits (Legacy)',
            description: 'Creates a new dated tab in the shared Google Doc. Replaced by W&I Open Critiques.',
            icon: <Palette size={24} />,
            color: '#8b5cf6',
            stats: `${projects.filter(p => p.status === 'active' || p.status === 'review').length} active projects across ${new Set(projects.flatMap(p => p.businessLines || [])).size} business lines`,
            docUrl: `https://docs.google.com/document/d/1QTw96d8wjB4UyrPwb6gXYpwpnLOBBrZuo7xoB48Z08k/edit`,
            syncDoc: syncOpenCritsDoc,
            syncing: openCritsSyncing,
            disabled: true,
          },
        ]

        return (
        <div className="reports-page">
          <div className="reports-grid">
            {reports.map(report => (
              <div key={report.id} className={`report-card${(report.id === 'weekly-status' && weeklySnapshots.length > 0) || (report.id === 'project-review' && reviewSnapshots.length > 0) ? ' report-card-has-history' : ''}${report.disabled ? ' report-card-disabled' : ''}`} style={report.disabled ? { opacity: 0.3, pointerEvents: 'none' } : undefined}>
                <div className="report-card-icon" style={{ color: report.color }}>
                  {report.icon}
                </div>
                <div className="report-card-body">
                  <h3 className="report-card-title">{report.title}</h3>
                  <p className="report-card-desc">{report.description}</p>
                  <span className="report-card-stats">{report.stats}</span>
                </div>
                {report.docUrl ? (
                  <div className="report-doc-actions">
                    <button className="report-generate-btn" onClick={report.syncDoc} disabled={report.syncing} style={{ borderColor: report.color, color: report.color }}>
                      {report.syncing ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />}
                      {report.syncing ? 'Syncing...' : 'Update Doc'}
                    </button>
                    <a className="report-generate-btn report-view-btn" href={report.docUrl} target="_blank" rel="noopener noreferrer" style={{ borderColor: report.color, color: report.color }}>
                      <LinkIcon size={14} />
                      View Doc
                    </a>
                  </div>
                ) : report.generate ? (
                  <button className="report-generate-btn" onClick={report.generate} style={{ borderColor: report.color, color: report.color }}>
                    <FileBarChart size={14} />
                    View Report
                  </button>
                ) : null}
                {report.id === 'weekly-status' && currentWeek && (
                  <div className="snapshot-accordion">
                    <button className="snapshot-accordion-toggle" onClick={() => setShowWeeklyPending(v => !v)}>
                      {showWeeklyPending ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Edit2 size={12} />
                      <span>Current Week ({currentWeek})</span>
                      {(() => {
                        const filledCategories = weeklyGeneral.filter(e => ['highlight', 'lowlight', 'fyi', 'people'].includes(e.category) && e.content.trim()).length
                        const count = filledCategories + weeklyUpdates.length
                        return count > 0 ? <span className="rr-section-count" style={{ marginLeft: 4 }}>{count}</span> : null
                      })()}
                    </button>
                    {showWeeklyPending && (
                      <div className="weekly-pending-panel">
                        {([
                          { category: 'highlight' as const, label: 'Highlights', color: '#22c55e', placeholder: 'General highlights (one per line)...' },
                          { category: 'lowlight' as const, label: 'Lowlights', color: '#ef4444', placeholder: 'General lowlights (one per line)...' },
                          { category: 'fyi' as const, label: 'Upcoming FYIs', color: '#f59e0b', placeholder: 'Upcoming FYIs (one per line)...' },
                          { category: 'people' as const, label: 'People Updates', color: '#8b5cf6', placeholder: 'People updates (one per line)...' },
                        ]).map(section => {
                          const allForCategory = weeklyGeneral.filter(e => e.category === section.category)
                          const existing = allForCategory[0]
                          const combinedContent = allForCategory.map(e => e.content).join('\n')
                          const merged = existing ? { ...existing, content: combinedContent } : undefined
                          return (
                            <div key={section.category} className="weekly-pending-section">
                              <div className="weekly-pending-header" style={{ color: section.color }}>
                                <span className="rr-section-dot" style={{ background: section.color }} />
                                <span>{section.label}</span>
                              </div>
                              <WeeklyPendingEditor
                                key={merged?.id || section.category}
                                existing={merged}
                                placeholder={section.placeholder}
                                onSave={async (content) => {
                                  for (const old of allForCategory.slice(1)) await deleteWeeklyGeneral(old.id)
                                  await saveWeeklyGeneral({ id: existing?.id, designer_id: String(currentUser?.id || 'admin'), week: currentWeek, category: section.category, content })
                                }}
                                onDelete={async () => {
                                  for (const old of allForCategory) await deleteWeeklyGeneral(old.id)
                                }}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                {report.id === 'weekly-status' && weeklySnapshots.length > 0 && (
                  <div className="snapshot-accordion">
                    <button className="snapshot-accordion-toggle" onClick={() => setShowSnapshotHistory(v => !v)}>
                      {showSnapshotHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Clock size={12} />
                      <span>Past Reports ({weeklySnapshots.length})</span>
                    </button>
                    {showSnapshotHistory && (
                      <div className="snapshot-accordion-body">
                        {weeklySnapshots.map(snap => (
                          <button key={snap.id} className="snapshot-item" onClick={() => viewSnapshot(snap)}>
                            <span className="snapshot-week">{snap.week}</span>
                            <span className="snapshot-date">{new Date(snap.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {report.id === 'project-review' && reviewSnapshots.length > 0 && (
                  <div className="snapshot-accordion">
                    <button className="snapshot-accordion-toggle" onClick={() => setShowReviewSnapshotHistory(v => !v)}>
                      {showReviewSnapshotHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Clock size={12} />
                      <span>Past Reports ({reviewSnapshots.length})</span>
                    </button>
                    {showReviewSnapshotHistory && (
                      <div className="snapshot-accordion-body">
                        {reviewSnapshots.map(snap => (
                          <button key={snap.id} className="snapshot-item" onClick={() => viewReviewSnapshot(snap)}>
                            <span className="snapshot-week">{snap.week}</span>
                            <span className="snapshot-date">{new Date(snap.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {copiedReport && (
            <div className="report-copied-toast">Report copied to clipboard — paste into Google Docs</div>
          )}
        </div>
        )
      })()}

      {/* Note Detail Modal */}
      {selectedNote && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setSelectedNote(null) }}>
          <div className="modal note-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="note-detail-header">
              <h2>{selectedNote.title || 'Untitled Note'}</h2>
              <div className="note-detail-actions">
                <button className="note-edit-btn" onClick={() => { setEditingNote(selectedNote); setSelectedNote(null); }}>
                  <Edit2 size={14} /> Edit
                </button>
                <button className="note-close-btn" onClick={() => setSelectedNote(null)}>&times;</button>
              </div>
            </div>
            <div className="note-detail-body">
              {selectedNote.linkedProjectIds.length > 0 && (
                <div className="note-detail-section">
                  <h4><FileText size={14} /> Linked Projects</h4>
                  <div className="note-detail-tags">
                    {selectedNote.linkedProjectIds.map(pid => {
                      const proj = projects.find(p => p.id === pid)
                      return proj ? (
                        <span key={pid} className="note-tag-wrapper">
                          <button className="note-tag project-tag clickable"
                            onClick={() => {
                              setSelectedNote(null)
                              setProjectFilters({ businessLines: [], designers: [], statuses: [], project: proj.name })
                              setActiveTab('projects')
                            }}>
                            {proj.name}
                          </button>
                        </span>
                      ) : null
                    })}
                  </div>
                </div>
              )}

              {selectedNote.linkedTeamIds.length > 0 && (
                <div className="note-detail-section">
                  <h4><Users size={14} /> Linked People</h4>
                  <div className="note-detail-tags">
                    {selectedNote.linkedTeamIds.map(tid => {
                      const member = team.find(m => m.id === tid)
                      return member ? (
                        <span key={tid} className="note-tag-wrapper">
                          <span className="note-tag person-tag">{member.name}</span>
                        </span>
                      ) : null
                    })}
                  </div>
                </div>
              )}

              {selectedNote.content_preview && (
                <div className="note-detail-section note-summary-section">
                  <h4>Summary</h4>
                  <p className="note-detail-content">
                    {highlightTextWithLinks(
                      selectedNote.content_preview,
                      projects,
                      team,
                      selectedNote.linkedProjectIds,
                      selectedNote.linkedTeamIds,
                      () => {}, // disabled
                      () => {}  // disabled
                    )}
                  </p>
                </div>
              )}

              {selectedNote.next_steps && (
                <div className="note-detail-section">
                  <h4><CheckSquare size={14} /> Next Steps</h4>
                  <ul className="note-steps-list">
                    {selectedNote.next_steps
                      .replace(/\u200B/g, '')
                      .split(/\n|•/)
                      .map(s => s.trim())
                      .flatMap(s => s.split(/\.\s+/))
                      .map(s => s.trim())
                      .filter(s => s.length > 10)
                      .map((step, i) => (
                        <li key={i}>
                          {highlightTextWithLinks(
                            step.replace(/\.$/, ''),
                            projects,
                            team,
                            selectedNote.linkedProjectIds,
                            selectedNote.linkedTeamIds,
                            () => {}, // disabled
                            () => {}  // disabled
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {selectedNote.details && (
                <div className="note-detail-section">
                  <button
                    className="note-detail-accordion-toggle"
                    onClick={() => setNoteDetailOpen(!noteDetailOpen)}
                  >
                    {noteDetailOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>Details</span>
                  </button>
                  {noteDetailOpen && (
                    <ul className="note-details-list">
                      {selectedNote.details.split('|').filter(d => d.trim()).map((detail, i) => (
                        <li key={i}>
                          {highlightTextWithLinks(
                            detail.trim(),
                            projects,
                            team,
                            selectedNote.linkedProjectIds,
                            selectedNote.linkedTeamIds,
                            () => {}, // disabled
                            () => {}  // disabled
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {selectedNote.attachments && (
                <div className="note-detail-section">
                  <h4><LinkIcon size={14} /> Attachments</h4>
                  <div className="note-attachments">
                    {selectedNote.attachments.split('|').map((att, i) => {
                      const match = att.match(/^(.+?):\s*(https?:\/\/.+)$/)
                      if (match) {
                        const [, name, url] = match
                        return (
                          <a key={i} href={url.trim()} target="_blank" rel="noopener" className="note-attachment-link">
                            {name.trim()}
                          </a>
                        )
                      }
                      return <span key={i} className="note-attachment-text">{att.trim()}</span>
                    })}
                  </div>
                </div>
              )}

              {selectedNote.source_filename && (
                <div className="note-detail-section">
                  <h4>Source</h4>
                  <p className="note-detail-source">{selectedNote.source_filename}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Note Edit Modal */}
      {editingNote && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setEditingNote(null) }}>
          <div className="modal note-edit-modal" onClick={e => e.stopPropagation()}>
            <div className="note-edit-header">
              <h2>Edit Note</h2>
              <button className="note-close-btn" onClick={() => setEditingNote(null)}>&times;</button>
            </div>
            <div className="note-edit-body">
              <div className="note-edit-field">
                <label htmlFor="note-title">Title</label>
                <input
                  id="note-title"
                  type="text"
                  value={editingNote.title}
                  onChange={e => setEditingNote({ ...editingNote, title: e.target.value })}
                  placeholder="Note title"
                />
              </div>
              
              <div className="note-edit-field">
                <label htmlFor="note-date">Date</label>
                <input
                  id="note-date"
                  type="date"
                  value={editingNote.date ? editingNote.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : ''}
                  onChange={e => {
                    const isoDate = e.target.value // YYYY-MM-DD
                    const compactDate = isoDate.replace(/-/g, '') // YYYYMMDD
                    setEditingNote({ ...editingNote, date: compactDate })
                  }}
                />
              </div>

              <div className="note-edit-field">
                <label>Projects</label>
                <div className="note-edit-tags">
                  {projects.map(proj => {
                    const isLinked = editingNote.linkedProjectIds.includes(proj.id)
                    return (
                      <button
                        key={proj.id}
                        className={`note-edit-tag-btn ${isLinked ? 'selected' : ''}`}
                        onClick={() => {
                          const newIds = isLinked
                            ? editingNote.linkedProjectIds.filter(id => id !== proj.id)
                            : [...editingNote.linkedProjectIds, proj.id]
                          setEditingNote({ ...editingNote, linkedProjectIds: newIds })
                        }}
                      >
                        <FileText size={12} /> {proj.name}
                      </button>
                    )
                  })}
                  {projects.length === 0 && <span className="note-edit-empty">No projects available</span>}
                </div>
              </div>

              <div className="note-edit-field">
                <label>People</label>
                <div className="note-edit-tags">
                  {team.map(member => {
                    const isLinked = editingNote.linkedTeamIds.includes(member.id)
                    return (
                      <button
                        key={member.id}
                        className={`note-edit-tag-btn ${isLinked ? 'selected' : ''}`}
                        onClick={() => {
                          const newIds = isLinked
                            ? editingNote.linkedTeamIds.filter(id => id !== member.id)
                            : [...editingNote.linkedTeamIds, member.id]
                          setEditingNote({ ...editingNote, linkedTeamIds: newIds })
                        }}
                      >
                        <User size={12} /> {member.name}
                      </button>
                    )
                  })}
                  {team.length === 0 && <span className="note-edit-empty">No team members available</span>}
                </div>
              </div>
            </div>
            <div className="note-edit-footer">
              <button 
                className="danger-btn-text" 
                onClick={() => {
                  setNoteToHide(editingNote)
                  setHideNotePin('')
                  setShowHideNotePinModal(true)
                }}
              >
                Hide Note
              </button>
              <div className="button-group">
                <button className="secondary-btn" onClick={() => setEditingNote(null)}>Cancel</button>
                <button className="primary-btn" onClick={async () => {
                try {
                  const res = await authFetch(`/api/notes/${editingNote.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      title: editingNote.title,
                      date: editingNote.date,
                      linkedProjectIds: editingNote.linkedProjectIds,
                      linkedTeamIds: editingNote.linkedTeamIds
                    })
                  })
                  if (res.ok) {
                    const updatedNote = await res.json()
                    setNotes(notes.map(n => n.id === updatedNote.id ? { ...n, ...updatedNote } : n))
                    setEditingNote(null)
                  } else {
                    const err = await res.json()
                    alert(`Error saving note: ${err.error}`)
                  }
                } catch (err) {
                  console.error('Error saving note:', err)
                  alert('Error saving note')
                }
              }}>Save Changes</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reviews View */}
      {activeTab === 'reviews' && (
        <div className="reviews-page">
          {reviews.length === 0 && !editingReview ? (
            <div className="reviews-empty">
              <ListChecks size={40} strokeWidth={1.5} />
              <h3>No reviews yet</h3>
              <p>Create a review to stage projects for your weekly design review.</p>
              <button className="primary-btn" style={{ marginTop: '1rem' }} onClick={() => {
                (() => {
                  const now = new Date()
                  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
                  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
                  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
                  const wk = Math.ceil(((t.getTime() - ys.getTime()) / 86400000 + 1) / 7)
                  const reviewIds = currentProjects.filter(p => p.status === 'review').map(p => p.id)
                  setCreateReviewForm({ title: `W&I Open Critique — Week ${wk}`, selectedProjectIds: reviewIds })
                  setShowCreateReviewModal(true)
                })()
              }}>+ New Review</button>
            </div>
          ) : editingReview ? (
            <div className="review-edit">
              <div className="review-edit-header">
                {/* Row 1: Review selector */}
                <div className="review-nav-top">
                  <select className="review-nav-select" value={editingReview.id} onChange={e => loadReviewDetail(e.target.value)}>
                    {(() => {
                      const getWeek = (d: Date) => {
                        const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
                        t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
                        const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
                        return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
                      }
                      const groups: Record<string, typeof reviews> = {}
                      for (const r of reviews) {
                        const d = new Date(r.created_at + 'Z')
                        const key = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
                        if (!groups[key]) groups[key] = []
                        groups[key].push(r)
                      }
                      return Object.entries(groups).map(([label, items]) => (
                        <optgroup key={label} label={label}>
                          {items.map(r => {
                            const d = new Date(r.created_at + 'Z')
                            const wk = getWeek(d)
                            const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            return <option key={r.id} value={r.id}>Week {wk} — {day}</option>
                          })}
                        </optgroup>
                      ))
                    })()}
                  </select>
                </div>

                {/* Row 2: Title + primary actions */}
                <div className="review-nav">
                  <input
                    className="review-title-input"
                    value={editingReview.title || ''}
                    onChange={e => setEditingReview({ ...editingReview, title: e.target.value })}
                    onBlur={async () => {
                      await authFetch(`/api/reviews/${editingReview.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: editingReview.title })
                      })
                    }}
                    placeholder="Review title"
                  />
                  <div className="review-nav-actions">
                    <button className="secondary-btn" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => {
                      const sid = getSessionId(); window.open(`${window.location.origin}/review/${editingReview.id}${sid ? '?sid=' + sid : ''}`, '_blank')
                    }}><Globe size={13} /> Public Review Site</button>
                    <button className="primary-btn" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => {
                      const now = new Date()
                      const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
                      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
                      const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
                      const wk = Math.ceil(((t.getTime() - ys.getTime()) / 86400000 + 1) / 7)
                      const reviewIds = currentProjects.filter(p => p.status === 'review').map(p => p.id)
                      setCreateReviewForm({ title: `W&I Open Critique — Week ${wk}`, selectedProjectIds: reviewIds })
                      setShowCreateReviewModal(true)
                    }}>+ New Review</button>
                  </div>
                </div>

                {/* Row 2b: Description */}
                <RichTextEditor
                  className="review-description-rte"
                  value={editingReview.description || ''}
                  onChange={(md) => setEditingReview({ ...editingReview, description: md })}
                  onBlur={async () => {
                    await authFetch(`/api/reviews/${editingReview.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ description: editingReview.description || '' })
                    })
                  }}
                  placeholder="Add a review description or summary..."
                  features={['bold', 'bullets', 'links']}
                  minHeight="40px"
                />

                {/* Row 3: Meta + actions inline */}
                <div className="review-edit-meta-row">
                  <span className="review-edit-meta">
                    {editingReview.items?.length || 0} project{(editingReview.items?.length || 0) !== 1 ? 's' : ''} · {new Date(editingReview.created_at + 'Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                  <span className="project-meta-chip project-meta-action" style={{ opacity: 1 }} onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/review/${editingReview.id}`)
                    setReviewCopied(true)
                    setTimeout(() => setReviewCopied(false), 2000)
                  }}>
                    <ClipboardCopy size={11} /> {reviewCopied ? 'Copied!' : 'Copy Link'}
                  </span>
                  <span className="project-meta-chip project-meta-action project-meta-action-delete" style={{ opacity: 1 }} onClick={() => setShowDeleteReviewModal(true)}>
                    <Trash2 size={11} /> Delete
                  </span>
                </div>
              </div>

              {/* Add project picker */}
              <div className="review-add-project">
                <select
                  className="review-project-select"
                  value=""
                  onChange={async (e) => {
                    const projectId = e.target.value
                    if (!projectId) return
                    await authFetch(`/api/reviews/${editingReview.id}/items`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ project_id: projectId })
                    })
                    loadReviewDetail(editingReview.id)
                  }}
                >
                  <option value="">Add a project...</option>
                  {currentProjects
                    .filter(p => !editingReview.items?.some((ri: any) => ri.project_id === p.id))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              </div>

              {/* Review items table */}
              {editingReview.items && editingReview.items.length > 0 ? (
                <DndContext
                  sensors={prioritySensors}
                  collisionDetection={closestCenter}
                  onDragEnd={async (e: DragEndEvent) => {
                    const { active, over } = e
                    if (!over || active.id === over.id) return
                    const items = editingReview.items as any[]
                    const oldIndex = items.findIndex((i: any) => i.id === active.id)
                    const newIndex = items.findIndex((i: any) => i.id === over.id)
                    if (oldIndex === -1 || newIndex === -1) return
                    const reordered = arrayMove(items, oldIndex, newIndex)
                    setEditingReview({ ...editingReview, items: reordered })
                    await authFetch(`/api/reviews/${editingReview.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ item_order: reordered.map((i: any) => i.id) })
                    })
                  }}
                >
                  <SortableContext items={(editingReview.items as any[]).map((i: any) => i.id)} strategy={verticalListSortingStrategy}>
                    <table className="review-items-table">
                      <thead>
                        <tr>
                          <th style={{ width: 36 }}></th>
                          <th style={{ width: 36 }}>#</th>
                          <th style={{ width: '60%' }}>Project</th>
                          <th style={{ width: '25%' }}>Links</th>
                          <th style={{ width: 40 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(editingReview.items as any[]).map((item: any, idx: number) => {
                          const proj = projects.find(p => p.id === item.project_id)
                          return (
                            <ReviewItemRow
                              key={item.id}
                              item={item}
                              index={idx}
                              project={proj || null}
                              authFetch={authFetch}
                              onRemove={async () => {
                                await authFetch(`/api/review-items/${item.id}`, { method: 'DELETE' })
                                loadReviewDetail(editingReview.id)
                              }}
                            />
                          )
                        })}
                      </tbody>
                    </table>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className="reviews-empty" style={{ padding: '2rem' }}>
                  <p>No projects added yet. Use the dropdown above to add projects.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="reviews-empty"><Loader size={24} className="spin" /></div>
          )}
        </div>
      )}

      {/* Create Review Modal */}
      {showCreateReviewModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === overlayMouseDownTarget.current && (e.target as HTMLElement).classList.contains('modal-overlay')) setShowCreateReviewModal(false) }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h2>New Review</h2>
              <button className="modal-close-btn" onClick={() => setShowCreateReviewModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className={`float-field${createReviewForm.title ? ' has-value' : ''}`} style={{ marginBottom: '1rem' }}>
                <input type="text" value={createReviewForm.title} onChange={e => setCreateReviewForm({ ...createReviewForm, title: e.target.value })}
                  placeholder=" " autoFocus />
                <label>Title</label>
              </div>
              <label className="review-picker-label">Projects</label>
              <div className="review-project-picker">
                {currentProjects
                  .filter(p => p.status === 'active' || p.status === 'review')
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(p => (
                    <label key={p.id} className="review-project-option">
                      <input type="checkbox" checked={createReviewForm.selectedProjectIds.includes(p.id)}
                        onChange={e => {
                          setCreateReviewForm(f => ({
                            ...f,
                            selectedProjectIds: e.target.checked
                              ? [...f.selectedProjectIds, p.id]
                              : f.selectedProjectIds.filter(id => id !== p.id)
                          }))
                        }} />
                      {p.name}
                      <span className="review-project-option-meta">
                        {p.status === 'active' ? 'Active' : p.status === 'review' ? 'In Review' : p.status}
                      </span>
                    </label>
                  ))}
              </div>
            </div>
            <div className="modal-actions" style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)' }}>
              <button className="secondary-btn" onClick={() => setShowCreateReviewModal(false)}>Cancel</button>
              <button
                className="primary-btn"
                disabled={!createReviewForm.title.trim()}
                onClick={async () => {
                  try {
                    // Set selected projects to 'review' status if not already
                    for (const pid of createReviewForm.selectedProjectIds) {
                      const proj = projects.find(p => p.id === pid)
                      if (proj && proj.status !== 'review') {
                        await saveProject({ ...proj, status: 'review' })
                      }
                    }
                    const res = await authFetch('/api/reviews', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        title: createReviewForm.title.trim(),
                        project_ids: createReviewForm.selectedProjectIds,
                      })
                    })
                    const review = await res.json()
                    setShowCreateReviewModal(false)
                    const data = await loadDataFromAPI()
                    if (data) { setProjects(data.projects || []) }
                    loadReviews(review.id)
                  } catch (err) { console.error('Error creating review:', err) }
                }}
              >
                Create Review
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteReviewModal && editingReview && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowDeleteReviewModal(false) }}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h2>Delete Review</h2>
              <button className="modal-close-btn" onClick={() => setShowDeleteReviewModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p>Are you sure you want to delete <strong>{editingReview.title}</strong>? This cannot be undone.</p>
            </div>
            <div className="modal-actions" style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)' }}>
              <button className="secondary-btn" onClick={() => setShowDeleteReviewModal(false)}>Cancel</button>
              <button className="danger-btn" onClick={async () => {
                await authFetch(`/api/reviews/${editingReview.id}`, { method: 'DELETE' })
                setShowDeleteReviewModal(false)
                setEditingReview(null)
                loadReviews()
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Settings View */}
      {activeTab === 'settings' && (
        <div className="settings-page">
          {/* Maintenance Mode Section (Admin Only) */}
          {isAdmin && (
            <div className="settings-section settings-admin-only">
              <div className="settings-header">
                <h2>Maintenance Mode</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.85rem', color: maintenance.enabled ? '#ef4444' : '#6b7280' }}>
                    {maintenance.enabled ? (maintenance.isLockout ? 'LOCKED OUT' : 'COUNTDOWN') : 'OFF'}
                  </span>
                </div>
              </div>

              <div className="maintenance-controls">
                {!maintenance.enabled ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
                      <div className="float-field has-value">
                        <input
                          type="text"
                          value={maintenanceForm.bannerMessage}
                          onChange={e => setMaintenanceForm(prev => ({ ...prev, bannerMessage: e.target.value }))}
                          placeholder=" "
                        />
                        <label>Banner Message (shown during countdown)</label>
                      </div>
                      <div className="float-field has-value">
                        <input
                          type="text"
                          value={maintenanceForm.lockoutMessage}
                          onChange={e => setMaintenanceForm(prev => ({ ...prev, lockoutMessage: e.target.value }))}
                          placeholder=" "
                        />
                        <label>Lockout Message (shown after countdown ends)</label>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <div className="float-field has-value" style={{ width: '120px' }}>
                          <input
                            type="number"
                            min="1"
                            max="120"
                            value={maintenanceForm.countdownMinutes}
                            onChange={e => {
                              const mins = parseInt(e.target.value) || 15
                              setMaintenanceForm(prev => ({
                                ...prev,
                                countdownMinutes: mins,
                                bannerMessage: `Save your work. Wandi Hub maintenance about to begin in ${mins} minute${mins !== 1 ? 's' : ''}.`
                              }))
                            }}
                            placeholder=" "
                          />
                          <label>Minutes</label>
                        </div>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>until lockout</span>
                      </div>
                    </div>
                    <button
                      className="primary-btn"
                      style={{ background: '#ef4444' }}
                      onClick={async () => {
                        const target = new Date(Date.now() + maintenanceForm.countdownMinutes * 60000).toISOString()
                        const body = {
                          enabled: true,
                          bannerMessage: maintenanceForm.bannerMessage || 'Save your work. Wandi Hub maintenance about to begin in 5 minutes.',
                          lockoutMessage: maintenanceForm.lockoutMessage || 'Wandi Hub will be back soon.',
                          countdownTarget: target,
                        }
                        const res = await authFetch('/api/maintenance', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body),
                        })
                        if (res.ok) {
                          const data = await res.json()
                          setMaintenance(data)
                        }
                      }}
                    >
                      Enable Maintenance Mode
                    </button>
                  </>
                ) : (
                  <div>
                    <div style={{ padding: '16px', background: 'var(--color-bg-hover)', borderRadius: '8px', marginBottom: '16px' }}>
                      <p style={{ marginBottom: '8px' }}><strong>Banner:</strong> {maintenance.bannerMessage || '(none)'}</p>
                      <p style={{ marginBottom: '8px' }}><strong>Lockout:</strong> {maintenance.lockoutMessage}</p>
                      {maintenance.countdownTarget && (
                        <p style={{ marginBottom: '0' }}>
                          <strong>Countdown:</strong>{' '}
                          {countdownDisplay === '0:00' ? (
                            <span style={{ color: '#ef4444', fontWeight: 600 }}>LOCKOUT ACTIVE</span>
                          ) : (
                            <span style={{ fontWeight: 600 }}>{countdownDisplay} remaining</span>
                          )}
                        </p>
                      )}
                      {!maintenance.countdownTarget && (
                        <p style={{ marginBottom: '0', color: '#ef4444', fontWeight: 600 }}>LOCKOUT ACTIVE (immediate)</p>
                      )}
                    </div>
                    <button
                      className="primary-btn"
                      style={{ background: '#22c55e' }}
                      onClick={async () => {
                        const res = await authFetch('/api/maintenance', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ enabled: false }),
                        })
                        if (res.ok) {
                          const data = await res.json()
                          setMaintenance(data)
                        }
                      }}
                    >
                      Disable Maintenance — Go Live
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* General Section — Account, Theme, Version */}
          <div className="settings-section">
            <div className="settings-header">
              <h2>General</h2>
            </div>
            <div className="settings-general-card">
              <div className="settings-row">
                <span>Account</span>
                <span className="settings-account-detail">{currentUser?.email} <span className="settings-role-badge">{currentUser?.role}</span></span>
              </div>
              <div className="settings-row">
                <span>Theme</span>
                <button className="theme-switch" onClick={toggleTheme} aria-label="Toggle theme">
                  <span className="theme-switch-track">
                    <Sun size={12} className="theme-switch-icon theme-switch-sun" />
                    <Moon size={12} className="theme-switch-icon theme-switch-moon" />
                    <span className="theme-switch-thumb" />
                  </span>
                </button>
              </div>
              <div className="settings-row">
                <span>Site version</span>
                <span className="settings-version-value">{formatVersionDisplay(siteVersion.version) || '-'}</span>
              </div>
              <div className="settings-row">
                <span>DB version</span>
                <span className="settings-version-value">{formatVersionDisplay(dbVersion.version) || '-'}</span>
              </div>
              <div className="settings-row">
                <span />
                <button className="secondary-btn" onClick={handleLogout}>Sign Out</button>
              </div>
            </div>
          </div>

          {/* Quarter Management */}
          <div className="settings-section">
            <div className="settings-header">
              <h2>Quarter Management</h2>
            </div>
            <div className="settings-general-card">
              <div className="settings-row">
                <span>Current Quarter</span>
                <span style={{ fontWeight: 600 }}>{getCurrentFiscalQuarter()}</span>
              </div>
              <div className="settings-row">
                <span>Previous Quarter</span>
                <span style={{ fontWeight: 600 }}>{getPreviousFiscalQuarter()}</span>
              </div>
              <div className="settings-row">
                <span>Done (unarchived)</span>
                <span>{currentProjects.filter(p => p.status === 'done').length} projects</span>
              </div>
              <div className="settings-row">
                <span>Archived</span>
                <span>{archivedProjects.length} projects across {Object.keys(archivedByQuarter).length} quarter{Object.keys(archivedByQuarter).length !== 1 ? 's' : ''}</span>
              </div>
              <div className="settings-row">
                <span />
                <button className="primary-btn" onClick={handleQuarterRollover}>
                  Archive to {getPreviousFiscalQuarter()}
                </button>
              </div>
            </div>
          </div>

          {/* Holidays Section (All Users) */}
          <div className="settings-section">
            <div className="settings-header">
              <h2>Special Days</h2>
              <button className="primary-btn" onClick={() => { setHolidayForm({ name: '', date: '' }); setShowHolidayModal(true) }}>+ Add Special Day</button>
            </div>
            <div className="timeline-list">
              {holidays.map(h => (
                <div key={h.id} className="timeline-item">
                  <div className="timeline-info">
                    <span className="timeline-name">{h.name}</span>
                    <span className="timeline-dates">{formatFullDate(h.date)}</span>
                  </div>
                  <div className="timeline-actions">
                    <button type="button" className="action-btn delete" onClick={() => {
                      openConfirmModal('Remove special day?', `This will remove "${h.name}" from the calendar.`, async () => {
                        const res = await authFetch(`/api/holidays/${h.id}`, { method: 'DELETE' })
                        if (res.ok) { setHolidays(await res.json()); setCalendarData(null) }
                        closeConfirmModal()
                      })
                    }}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
              {holidays.length === 0 && <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>No special days added yet.</p>}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-header">
              <h2>Business Lines</h2>
              <button className="primary-btn" onClick={() => {
                setEditingBusinessLine(null)
                setBusinessLineFormData({ name: '', customLinks: [] })
                setBlImages([])
                setShowBusinessLineModal(true)
              }}>
                + Add Business Line
              </button>
            </div>
            
            {businessLines.length === 0 ? (
              <p className="settings-empty">No business lines configured. Add one to get started.</p>
            ) : (
              <div className="business-lines-list">
                {businessLines.map(line => (
                  <div key={line.id} className="business-line-card">
                    <div className="business-line-header">
                      <h3>{line.name}</h3>
                      <div className="business-line-actions">
                        <button className="action-btn" onClick={() => {
                          setEditingBusinessLine(line)
                          setBusinessLineFormData({
                            name: line.name,
                            customLinks: line.customLinks || []
                          })
                          authFetch(`/api/images?project_id=${line.id}`).then(r => r.json()).then(setBlImages).catch(() => setBlImages([]))
                          setShowBusinessLineModal(true)
                        }}>
                          <Pencil size={14} />
                        </button>
                        <button className="action-btn delete" onClick={() => openConfirmModal('Delete business line?', `This will remove "${line.name}" and its links.`, async () => {
                          await deleteBusinessLine(line.id)
                          closeConfirmModal()
                        })}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="business-line-links">
                      {line.customLinks?.map((link, idx) => (
                        <a key={idx} href={link.url} target="_blank" rel="noopener noreferrer" className="project-footer-link">
                          <LinkIcon size={12} />
                          <span>{link.name}</span>
                        </a>
                      ))}
                    </div>
                    {(() => {
                      const imgs = allProjectImages.filter(i => i.project_id === line.id)
                      if (imgs.length === 0) return null
                      return (
                        <div className="project-attached-images">
                          <span className="project-attached-label">Attached images</span>
                          <div className="project-images-inline">
                            {imgs.slice(0, 4).map((img, idx) => (
                              <div key={img.id} className="project-image-thumb">
                                <img src={`/api/images/${img.id}`} alt={img.caption || img.original_name} loading="lazy"
                                  onClick={() => setLightbox({ images: imgs, index: idx })} />
                              </div>
                            ))}
                            {imgs.length > 4 && <span className="project-card-images">+{imgs.length - 4} more</span>}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* User Management Section (Admin Only) */}
          {isAdmin && (
            <div className="settings-section settings-admin-only">
              <div className="settings-header">
                <h2>User Accounts</h2>
                <button className="primary-btn" onClick={() => {
                  setUserFormData({ email: '', password: '', role: 'user' })
                  setShowUserModal(true)
                  fetchUsers()
                }}>
                  + Add User
                </button>
              </div>
              
              {users.length === 0 ? (
                <p className="settings-empty">No user accounts. Add one to get started.</p>
              ) : (
                <div className="users-list">
                  {users.map(user => (
                    <div key={user.id} className="user-card">
                      <div className="user-info">
                        <h3>{user.email}</h3>
                        <span className="user-role">{user.role}</span>
                      </div>
                      <div className="user-actions">
                        <button 
                          className="action-btn delete" 
                          onClick={() => handleDeleteUser(user.id)}
                          disabled={user.id === currentUser?.id}
                          title={user.id === currentUser?.id ? "Cannot delete your own account" : "Delete user"}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Hidden Notes Section (Admin Only) */}
          {isAdmin && <div className="settings-section settings-admin-only">
            <div className="settings-header">
              <h2>Hidden Notes</h2>
              {!hiddenNotesUnlocked && (
                <button className="secondary-btn" onClick={() => setShowHiddenNotesPinModal(true)}>
                  Unlock
                </button>
              )}
              {hiddenNotesUnlocked && (
                <button className="secondary-btn" onClick={() => setHiddenNotesUnlocked(false)}>
                  Lock
                </button>
              )}
            </div>

            {hiddenNotesUnlocked ? (
              hiddenNotes.length === 0 ? (
                <p className="settings-empty">No hidden notes.</p>
              ) : (
                <div className="hidden-notes-list">
                  {hiddenNotes.map(note => (
                    <div key={note.id} className="hidden-note-card">
                      <div className="hidden-note-info">
                        <h3>{note.title || 'Untitled Note'}</h3>
                        {note.hidden_at && (
                          <span className="hidden-note-date">
                            Hidden: {new Date(note.hidden_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <div className="hidden-note-actions">
                        <button
                          className="action-btn"
                          onClick={async () => {
                            try {
                              const res = await authFetch(`/api/notes/${note.id}/restore`, { method: 'PUT' })
                              if (res.ok) {
                                setHiddenNotes(hiddenNotes.filter(n => n.id !== note.id))
                                const notesRes = await authFetch('/api/notes')
                                const notesData = await notesRes.json()
                                setNotes(notesData)
                              }
                            } catch (err) {
                              console.error('Error restoring note:', err)
                            }
                          }}
                        >
                          <RefreshCw size={14} /> Restore
                        </button>
                        <button
                          className="action-btn delete"
                          onClick={() => openConfirmModal('Delete note?', `This will permanently delete "${note.title || 'Untitled Note'}".`, async () => {
                            try {
                              const res = await authFetch(`/api/notes/${note.id}`, { method: 'DELETE' })
                              if (res.ok) {
                                setHiddenNotes(hiddenNotes.filter(n => n.id !== note.id))
                              }
                            } catch (err) {
                              console.error('Error deleting note:', err)
                            }
                            closeConfirmModal()
                          })}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <p className="settings-empty">Click "Unlock" to view hidden notes.</p>
            )}
          </div>}

        </div>
      )}

        </div>
      </main>

      {/* Modal */}
      {showModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowModal(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingMember ? 'Edit Team Member' : 'Add Team Member'}</h2>
            </div>

            <div className="modal-body">
              <div className="form-section">
                <div className="form-section-title">Identity</div>
                <div className="form-row">
                  <div className={`float-field${formData.name ? ' has-value' : ''}`}>
                    <input
                      id="name"
                      type="text"
                      value={formData.name}
                      onChange={e => { const v = e.target.value; setFormData(prev => ({ ...prev, name: v })) }}
                      placeholder=" "
                    />
                    <label htmlFor="name">Name</label>
                  </div>
                  <div className={`float-field${formData.role ? ' has-value' : ''}`}>
                    <input
                      id="role"
                      type="text"
                      value={formData.role}
                      onChange={e => { const v = e.target.value; setFormData(prev => ({ ...prev, role: v })) }}
                      placeholder=" "
                    />
                    <label htmlFor="role">Role</label>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Contact</div>
                <div className="form-row">
                  <div className={`float-field${formData.slack ? ' has-value' : ''}`}>
                    <input
                      id="slack"
                      type="url"
                      value={formData.slack}
                      onChange={e => { const v = e.target.value; setFormData(prev => ({ ...prev, slack: v })) }}
                      placeholder=" "
                    />
                    <label htmlFor="slack">Slack Link</label>
                  </div>
                  <div className={`float-field${formData.email ? ' has-value' : ''}`}>
                    <input
                      id="email"
                      type="url"
                      value={formData.email}
                      onChange={e => { const v = e.target.value; setFormData(prev => ({ ...prev, email: v })) }}
                      placeholder=" "
                    />
                    <label htmlFor="email">Email Link</label>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Business Lines</div>

                <div className="form-group">
                  <div className="brand-checkboxes">
                    {brandOptions.map(brand => (
                      <label key={brand} className={`brand-checkbox ${formData.brands.includes(brand) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={formData.brands.includes(brand)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFormData(prev => ({ ...prev, brands: [...prev.brands, brand] }))
                            } else {
                              setFormData(prev => ({ ...prev, brands: prev.brands.filter(b => b !== brand) }))
                            }
                          }}
                        />
                        {brand}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div className="timeline-header">
                  <span className="form-section-title" style={{ marginBottom: 0 }}>Time Off</span>
                  <button type="button" className="add-timeline-btn" onClick={handleAddTimeOff}>+ Add</button>
                </div>
                {(formData.timeOff?.length ?? 0) > 0 && (
                  <div className="timeline-list" style={{ marginTop: '0.5rem' }}>
                    {formData.timeOff.map(off => (
                      <div key={off.id} className="timeline-item">
                        <div className="timeline-info">
                          <span className="timeline-name">{off.name}</span>
                          <span className="timeline-dates">{formatShortDate(off.startDate)} → {formatShortDate(off.endDate)}</span>
                        </div>
                        <div className="timeline-actions">
                          <button type="button" className="action-btn" onClick={() => handleEditTimeOff(off)}><Pencil size={14} /></button>
                          <button type="button" className="action-btn delete" onClick={() => handleDeleteTimeOff(off.id)}><Trash2 size={14} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => { setShowModal(false) }}>Cancel</button>
              <button className="primary-btn" onClick={handleSave}>
                {editingMember ? 'Save Changes' : 'Add Member'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showProjectModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowProjectModal(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingProject ? 'Edit Project' : 'New Project'}</h2>
              {editingProject && (
                <button className="modal-duplicate-btn" onClick={() => {
                  const phase = editingProject.name.match(/Phase\s+(\d+)/i)
                  const nextPhase = phase ? parseInt(phase[1]) + 1 : 2
                  const newName = phase
                    ? editingProject.name.replace(/Phase\s+\d+/i, `Phase ${nextPhase}`)
                    : `${editingProject.name} (Phase ${nextPhase})`
                  setProjectFormData({
                    ...projectFormData,
                    name: newName,
                    startDate: '',
                    endDate: '',
                    estimatedHours: 0,
                  })
                  setEditingProject(null)
                  setShowProjectModal(true)
                }}>
                  <Copy size={13} />
                  Duplicate
                </button>
              )}
            </div>
            
            <div className="modal-body">

              {/* Basic Info */}
              <div className="form-section">
                <div className="form-section-title">Basic Info</div>
                <div className="form-row">
                  <div className={`float-field${projectFormData.name ? ' has-value' : ''}`}>
                    <input
                      id="project-name"
                      type="text"
                      value={projectFormData.name}
                      onChange={e => setProjectFormData({ ...projectFormData, name: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="project-name">Project Name</label>
                  </div>
                  <div className={`float-field${projectFormData.url ? ' has-value' : ''}`}>
                    <input
                      id="project-url"
                      type="url"
                      value={projectFormData.url}
                      onChange={e => setProjectFormData({ ...projectFormData, url: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="project-url">Jira Project Link</label>
                  </div>
                </div>
                <div className="rte-float-field" style={{ marginTop: '1.25rem' }}>
                  <label className="rte-float-label">Description (optional)</label>
                  <RichTextEditor
                    value={projectFormData.description}
                    onChange={(md) => setProjectFormData({ ...projectFormData, description: md })}
                    placeholder="Project description..."
                    features={['bold', 'bullets', 'links']}
                    minHeight="48px"
                  />
                </div>
                <div className="form-group" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
                  <div className="form-section-title" style={{ marginBottom: '0.5rem' }}>Business Lines</div>
                  <div className="brand-checkboxes">
                    {brandOptions.map(brand => (
                      <label key={brand} className={`brand-checkbox ${projectFormData.businessLines.includes(brand) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={projectFormData.businessLines.includes(brand)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setProjectFormData({ ...projectFormData, businessLines: [...projectFormData.businessLines, brand] })
                            } else {
                              setProjectFormData({ ...projectFormData, businessLines: projectFormData.businessLines.filter(b => b !== brand) })
                            }
                          }}
                        />
                        {brand}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
                  <div className="form-section-title" style={{ marginBottom: '0.5rem' }}>Designers</div>
                  <div className="designer-checkboxes">
                    {[...team].sort((a, b) => a.name.localeCompare(b.name)).map(member => (
                      <label key={member.id} className={`designer-checkbox ${projectFormData.designers.includes(member.name) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={projectFormData.designers.includes(member.name)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setProjectFormData({ ...projectFormData, designers: [...projectFormData.designers, member.name] })
                            } else {
                              setProjectFormData({ ...projectFormData, designers: projectFormData.designers.filter(d => d !== member.name) })
                            }
                          }}
                        />
                        {member.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* Status & Schedule */}
              <div className="form-section">
                <div className="form-section-title">Status</div>
                <div className="status-select-wrapper" style={{ marginBottom: '0.6rem' }}>
                  <span className={`status-dot ${getStatusColor(projectFormData.status)}`} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', zIndex: 1 }}></span>
                  <select
                    className="status-select"
                    value={projectFormData.status}
                    onChange={e => setProjectFormData({ ...projectFormData, status: e.target.value as Project['status'] })}
                  >
                    {(['active', 'review', 'done', 'blocked', 'pending'] as const).map(s => (
                      <option key={s} value={s}>{getStatusLabel(s)}</option>
                    ))}
                  </select>
                </div>

                <div className="form-section-title" style={{ marginBottom: '0.4rem' }}>Schedule</div>
                <div className="form-row" style={{ marginBottom: '0.6rem' }}>
                  <div className={`float-field${projectFormData.startDate ? ' has-value' : ''}`}>
                    <input
                      id="start-date"
                      type="date"
                      value={projectFormData.startDate}
                      onChange={e => setProjectFormData({ ...projectFormData, startDate: e.target.value })}
                      onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                      placeholder=" "
                    />
                    <label htmlFor="start-date">Start Date</label>
                  </div>
                  <div className={`float-field${projectFormData.endDate ? ' has-value' : ''}`}>
                    <input
                      id="end-date"
                      type="date"
                      value={projectFormData.endDate}
                      onChange={e => setProjectFormData({ ...projectFormData, endDate: e.target.value })}
                      onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                      placeholder=" "
                    />
                    <label htmlFor="end-date">End Date</label>
                  </div>
                </div>

                <div className="form-row" style={{ marginBottom: '0.6rem' }}>
                  <div className="float-field has-value">
                    <select
                      id="estimate-size"
                      value={[35,70,105,175,280,455,910].includes(projectFormData.estimatedHours) ? String(projectFormData.estimatedHours) : ''}
                      onChange={e => {
                        const v = Number(e.target.value)
                        if (v) setProjectFormData({ ...projectFormData, estimatedHours: v })
                      }}
                    >
                      <option value="">Custom</option>
                      <option value="35">XXS — ≤1 week</option>
                      <option value="70">XS — 2 weeks</option>
                      <option value="105">S — 3 weeks</option>
                      <option value="175">M — 5 weeks</option>
                      <option value="280">L — 8 weeks</option>
                      <option value="455">XL — 13 weeks</option>
                      <option value="910">XXL — 26 weeks</option>
                    </select>
                    <label htmlFor="estimate-size">Effort Size</label>
                  </div>
                  <div className={`float-field${projectFormData.estimatedHours ? ' has-value' : ''}`}>
                    <input
                      id="estimated-hours"
                      type="number"
                      min={0}
                      step={1}
                      value={projectFormData.estimatedHours || ''}
                      onChange={e => setProjectFormData({ ...projectFormData, estimatedHours: Number(e.target.value) || 0 })}
                      placeholder=" "
                    />
                    <label htmlFor="estimated-hours">Estimated Hours</label>
                  </div>
                </div>

                <div className="timeline-header">
                  <span className="form-section-title" style={{ marginBottom: 0 }}>Timeline Ranges</span>
                  <button type="button" className="add-timeline-btn" onClick={handleAddTimeline}>+ Add Range</button>
                </div>
                {projectFormData.timeline.length > 0 && (
                  <DndContext sensors={timelineSensors} collisionDetection={closestCenter} onDragEnd={handleTimelineDragEnd}>
                    <SortableContext items={projectFormData.timeline.map(t => t.id)} strategy={verticalListSortingStrategy}>
                      <div className="timeline-list" style={{ marginTop: '0.5rem' }}>
                        {projectFormData.timeline.map(range => (
                          <SortableTimelineItem
                            key={range.id}
                            range={range}
                            onEdit={handleEditTimeline}
                            onDelete={handleDeleteTimeline}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </div>

              {/* Design Artifacts */}
              <div className="form-section">
                <div className="form-section-title">Design Artifacts</div>
                <div className="form-row" style={{ marginBottom: '0.5rem' }}>
                  <div className={`float-field${projectFormData.deckName ? ' has-value' : ''}`}>
                    <input
                      id="deck-name"
                      type="text"
                      value={projectFormData.deckName}
                      onChange={e => setProjectFormData({ ...projectFormData, deckName: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="deck-name">Design Deck Name</label>
                  </div>
                  <div className={`float-field${projectFormData.deckLink ? ' has-value' : ''}`}>
                    <input
                      id="deck-link"
                      type="url"
                      value={projectFormData.deckLink}
                      onChange={e => setProjectFormData({ ...projectFormData, deckLink: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="deck-link">Design Deck Link</label>
                  </div>
                </div>
                <div className="form-row" style={{ marginBottom: '0.5rem' }}>
                  <div className={`float-field${projectFormData.prdName ? ' has-value' : ''}`}>
                    <input
                      id="prd-name"
                      type="text"
                      value={projectFormData.prdName}
                      onChange={e => setProjectFormData({ ...projectFormData, prdName: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="prd-name">PRD Name</label>
                  </div>
                  <div className={`float-field${projectFormData.prdLink ? ' has-value' : ''}`}>
                    <input
                      id="prd-link"
                      type="url"
                      value={projectFormData.prdLink}
                      onChange={e => setProjectFormData({ ...projectFormData, prdLink: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="prd-link">PRD Link</label>
                  </div>
                </div>
                <div className="form-row" style={{ marginBottom: '0.5rem' }}>
                  <div className={`float-field${projectFormData.briefName ? ' has-value' : ''}`}>
                    <input
                      id="brief-name"
                      type="text"
                      value={projectFormData.briefName}
                      onChange={e => setProjectFormData({ ...projectFormData, briefName: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="brief-name">Design Brief Name</label>
                  </div>
                  <div className={`float-field${projectFormData.briefLink ? ' has-value' : ''}`}>
                    <input
                      id="brief-link"
                      type="url"
                      value={projectFormData.briefLink}
                      onChange={e => setProjectFormData({ ...projectFormData, briefLink: e.target.value })}
                      placeholder=" "
                    />
                    <label htmlFor="brief-link">Design Brief Link</label>
                  </div>
                </div>
                <div className={`float-field${projectFormData.figmaLink ? ' has-value' : ''}`}>
                  <input
                    id="figma-link"
                    type="url"
                    value={projectFormData.figmaLink}
                    onChange={e => setProjectFormData({ ...projectFormData, figmaLink: e.target.value })}
                    placeholder=" "
                  />
                  <label htmlFor="figma-link">Figma Link</label>
                </div>
              </div>

              {/* Custom Links */}
              <div className="form-section">
                <div className="form-section-title">Custom Links</div>
                {projectFormData.customLinks?.map((link, idx) => (
                  <CustomLinkRow
                    key={idx}
                    link={link}
                    onChange={updated => {
                      const newLinks = [...projectFormData.customLinks]
                      newLinks[idx] = updated
                      setProjectFormData({ ...projectFormData, customLinks: newLinks })
                    }}
                    onRemove={() => openConfirmModal('Remove custom link?', 'This link will be removed from the project.', () => {
                      const newLinks = projectFormData.customLinks.filter((_, i) => i !== idx)
                      setProjectFormData({ ...projectFormData, customLinks: newLinks })
                      closeConfirmModal()
                    })}
                  />
                ))}
                {(
                  <button
                    type="button"
                    className="add-link-btn"
                    onClick={() => {
                      const newLinks = [...(projectFormData.customLinks || []), { name: '', url: '' }];
                      setProjectFormData({ ...projectFormData, customLinks: newLinks });
                    }}
                  >+ Add Custom Link</button>
                )}
              </div>

              {/* Images */}
              {editingProject && (
                <div className="form-section">
                  <div className="form-section-title">Images</div>
                  <div
                    className={`project-image-drop${uploadingImage ? ' uploading' : ''}`}
                    onPaste={async (e) => {
                      const items = e.clipboardData?.items
                      if (!items) return
                      for (const item of Array.from(items)) {
                        if (item.type.startsWith('image/')) {
                          e.preventDefault()
                          const file = item.getAsFile()
                          if (file) await uploadProjectImage(editingProject.id, file, file.name || 'pasted-image.png')
                          return
                        }
                      }
                    }}
                    onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('dragover') }}
                    onDragLeave={e => e.currentTarget.classList.remove('dragover')}
                    onDrop={async (e) => {
                      e.preventDefault()
                      e.currentTarget.classList.remove('dragover')
                      const files = e.dataTransfer?.files
                      if (!files) return
                      for (const file of Array.from(files)) {
                        if (file.type.startsWith('image/')) {
                          await uploadProjectImage(editingProject.id, file, file.name)
                        }
                      }
                    }}
                    tabIndex={0}
                  >
                    {uploadingImage && <div className="project-image-uploading"><Loader size={14} className="spin" /> Uploading...</div>}
                    {!uploadingImage && projectImages.length === 0 && (
                      <div className="project-image-placeholder">Paste or drag an image here</div>
                    )}
                    {projectImages.length > 0 && (
                      <DndContext
                        sensors={prioritySensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(e: DragEndEvent) => {
                          const { active, over } = e
                          if (!over || active.id === over.id) return
                          const oldIndex = projectImages.findIndex(i => i.id === active.id)
                          const newIndex = projectImages.findIndex(i => i.id === over.id)
                          if (oldIndex === -1 || newIndex === -1) return
                          const reordered = arrayMove(projectImages, oldIndex, newIndex)
                          reorderProjectImages(editingProject.id, reordered)
                        }}
                      >
                        <SortableContext items={projectImages.map(i => i.id)} strategy={verticalListSortingStrategy}>
                          <div className="project-image-grid">
                            {projectImages.map((img, idx) => (
                              <SortableImageItem
                                key={img.id}
                                img={img}
                                index={idx}
                                images={projectImages}
                                onOpenLightbox={(imgs, i) => setLightbox({ images: imgs, index: i })}
                                onDelete={deleteProjectImage}
                                onCaptionBlur={updateImageCaption}
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                </div>
              )}

            </div>

            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setShowProjectModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={handleSaveProject}>
                {editingProject ? 'Save Changes' : 'Add Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTimelineModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-header">
              <h2>{editingTimeline ? 'Edit Timeline Range' : 'Add Timeline Range'}</h2>
            </div>
            <div className="modal-body">
              <div className={`float-field${timelineFormData.name ? ' has-value' : ''}`} style={{ marginBottom: '0.5rem' }}>
                <input
                  id="timeline-name"
                  type="text"
                  value={timelineFormData.name}
                  onChange={e => setTimelineFormData({ ...timelineFormData, name: e.target.value })}
                  placeholder=" "
                />
                <label htmlFor="timeline-name">Range Name</label>
              </div>
              <div className="form-row">
                <div className={`float-field${timelineFormData.startDate ? ' has-value' : ''}`}>
                  <input
                    id="timeline-start"
                    type="date"
                    value={timelineFormData.startDate}
                    onChange={e => setTimelineFormData({ ...timelineFormData, startDate: e.target.value })}
                    onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                    placeholder=" "
                  />
                  <label htmlFor="timeline-start">Start Date</label>
                </div>
                <div className={`float-field${timelineFormData.endDate ? ' has-value' : ''}`}>
                  <input
                    id="timeline-end"
                    type="date"
                    value={timelineFormData.endDate}
                    onChange={e => setTimelineFormData({ ...timelineFormData, endDate: e.target.value })}
                    onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                    placeholder=" "
                  />
                  <label htmlFor="timeline-end">End Date</label>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setShowTimelineModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={handleSaveTimeline}>{editingTimeline ? 'Save Changes' : 'Add Range'}</button>
            </div>
          </div>
        </div>
      )}

      {showHolidayModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-header">
              <h2>Add Special Day</h2>
            </div>
            <div className="modal-body">
              <div className={`float-field${holidayForm.name ? ' has-value' : ''}`} style={{ marginBottom: '0.5rem' }}>
                <input
                  type="text"
                  value={holidayForm.name}
                  onChange={e => setHolidayForm({ ...holidayForm, name: e.target.value })}
                  placeholder=" "
                />
                <label>Name</label>
              </div>
              <div className={`float-field${holidayForm.date ? ' has-value' : ''}`}>
                <input
                  type="date"
                  value={holidayForm.date}
                  onChange={e => setHolidayForm({ ...holidayForm, date: e.target.value })}
                  onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                  placeholder=" "
                />
                <label>Date</label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setShowHolidayModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={async () => {
                if (!holidayForm.name || !holidayForm.date) return
                const res = await authFetch('/api/holidays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(holidayForm) })
                if (res.ok) { setHolidays(await res.json()); setCalendarData(null); setShowHolidayModal(false); setHolidayForm({ name: '', date: '' }) }
              }}>Add Special Day</button>
            </div>
          </div>
        </div>
      )}

      {riskDetail && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setRiskDetail(null) }}>
          <div className="modal risk-detail-modal" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h2>{riskDetail.title}</h2>
              <button className="modal-close-btn" onClick={() => setRiskDetail(null)}><span>&times;</span></button>
            </div>
            <div className="modal-body">
              <div className="risk-detail-list">
                {riskDetail.items.map((item, i) => (
                  <div key={i} className="risk-detail-row">
                    {item.projectName ? (
                      <a className="risk-detail-name risk-detail-link" onClick={() => {
                        setRiskDetail(null)
                        setActiveTab('projects')
                        setProjectFilters({ businessLines: [], designers: [], statuses: [], project: item.projectName! })
                      }}>{item.name}</a>
                    ) : (
                      <span className="risk-detail-name">{item.name}</span>
                    )}
                    <span className="risk-detail-info">{item.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showTimeOffModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-header">
              <h2>{editingTimeOff ? 'Edit Time Off' : 'Add Time Off'}</h2>
            </div>
            <div className="modal-body">
              <div className={`float-field${timeOffFormData.name ? ' has-value' : ''}`} style={{ marginBottom: '0.5rem' }}>
                <input
                  id="timeoff-name"
                  type="text"
                  value={timeOffFormData.name}
                  onChange={e => setTimeOffFormData({ ...timeOffFormData, name: e.target.value })}
                  placeholder=" "
                />
                <label htmlFor="timeoff-name">Label (e.g., Vacation)</label>
              </div>
              <div className="form-row">
                <div className={`float-field${timeOffFormData.startDate ? ' has-value' : ''}`}>
                  <input
                    id="timeoff-start"
                    type="date"
                    value={timeOffFormData.startDate}
                    onChange={e => setTimeOffFormData({ ...timeOffFormData, startDate: e.target.value })}
                    onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                    placeholder=" "
                  />
                  <label htmlFor="timeoff-start">Start Date</label>
                </div>
                <div className={`float-field${timeOffFormData.endDate ? ' has-value' : ''}`}>
                  <input
                    id="timeoff-end"
                    type="date"
                    value={timeOffFormData.endDate}
                    onChange={e => setTimeOffFormData({ ...timeOffFormData, endDate: e.target.value })}
                    onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                    placeholder=" "
                  />
                  <label htmlFor="timeoff-end">End Date</label>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setShowTimeOffModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={handleSaveTimeOff}>{editingTimeOff ? 'Save Changes' : 'Add Time Off'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Time-Off Modal (calendar click) */}
      {quickTimeOff && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setQuickTimeOff(null) }}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>My Time Off</h2>
              <button className="close-btn" onClick={() => setQuickTimeOff(null)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{quickTimeOff.member.name}</span>
                {quickTimeOff.dayEvents.length > 0 && (
                  <button style={{ fontSize: '0.8rem', background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', padding: 0 }} onClick={() => {
                    const { date, dayEvents, dayName } = quickTimeOff
                    setQuickTimeOff(null)
                    setSelectedDay({ date, events: dayEvents, dayName })
                  }}>View day events</button>
                )}
              </div>

              {/* Existing time off entries */}
              {(quickTimeOff.member.timeOff?.length ?? 0) > 0 && (
                <div className="timeline-list" style={{ marginBottom: '0.75rem' }}>
                  {quickTimeOff.member.timeOff!.map(off => (
                    <div key={off.id} className="timeline-item">
                      <div className="timeline-info">
                        <span className="timeline-name">{off.name}</span>
                        <span className="timeline-dates">{formatShortDate(off.startDate)} → {formatShortDate(off.endDate)}</span>
                      </div>
                      <div className="timeline-actions">
                        <button type="button" className="action-btn" onClick={() => handleQuickTimeOffEdit(off)}><Pencil size={14} /></button>
                        <button type="button" className="action-btn delete" onClick={() => handleQuickTimeOffDelete(off.id)}><Trash2 size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add / Edit form */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                  {quickTimeOff.editEntry ? 'Edit Entry' : 'Add Time Off'}
                </div>
                <div className={`float-field${quickTimeOffForm.name ? ' has-value' : ''}`} style={{ marginBottom: '0.5rem' }}>
                  <input
                    id="quick-timeoff-name"
                    type="text"
                    value={quickTimeOffForm.name}
                    onChange={e => setQuickTimeOffForm({ ...quickTimeOffForm, name: e.target.value })}
                    placeholder=" "
                  />
                  <label htmlFor="quick-timeoff-name">Label (e.g., Vacation)</label>
                </div>
                <div className="form-row">
                  <div className={`float-field${quickTimeOffForm.startDate ? ' has-value' : ''}`}>
                    <input
                      id="quick-timeoff-start"
                      type="date"
                      value={quickTimeOffForm.startDate}
                      onChange={e => setQuickTimeOffForm({ ...quickTimeOffForm, startDate: e.target.value })}
                      onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                      placeholder=" "
                    />
                    <label htmlFor="quick-timeoff-start">Start Date</label>
                  </div>
                  <div className={`float-field${quickTimeOffForm.endDate ? ' has-value' : ''}`}>
                    <input
                      id="quick-timeoff-end"
                      type="date"
                      value={quickTimeOffForm.endDate}
                      onChange={e => setQuickTimeOffForm({ ...quickTimeOffForm, endDate: e.target.value })}
                      onClick={e => (e.target as HTMLInputElement).showPicker?.()}
                      placeholder=" "
                    />
                    <label htmlFor="quick-timeoff-end">End Date</label>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              {quickTimeOff.editEntry && (
                <button className="secondary-btn" onClick={() => {
                  setQuickTimeOff(prev => prev ? { ...prev, editEntry: null } : null)
                  setQuickTimeOffForm({ name: '', startDate: quickTimeOff.date, endDate: quickTimeOff.date })
                }}>Cancel Edit</button>
              )}
              <button className="primary-btn" onClick={handleQuickTimeOffSave}>
                {quickTimeOff.editEntry ? 'Save Changes' : 'Add Time Off'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calendar Day Modal */}
      {selectedDay && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setSelectedDay(null) }}>
          <div className="modal day-modal" onClick={e => e.stopPropagation()}>
            <div className="day-modal-header">
              <h2>
                {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </h2>
              <button className="close-btn" onClick={() => setSelectedDay(null)}>×</button>
            </div>
            <div className="day-modal-content">
              {selectedDay.events.map((event: CalendarEvent, idx: number) => (
                <div 
                  key={idx} 
                  className={`day-modal-event ${event.type === 'timeoff' ? 'timeoff' : event.type === 'holiday' ? 'holiday' : 'project'} ${event.type === 'project' ? 'clickable' : ''}`}
                  onClick={() => event.type === 'project' && handleEventClick(event)}
                >
                  {event.type === 'timeoff' && (
                    <div className="event-type-badge">
                      <span style={{ marginRight: '5px' }}>🌴</span>
                      {event.startDate && event.endDate && (
                        <span className="event-date-range-inline">{formatDateRange(event.startDate, event.endDate)}</span>
                      )}
                    </div>
                  )}
                  {(event.type === 'project' || event.type === 'holiday') && event.startDate && event.endDate && (
                    <div className="event-type-badge">
                      <span className="event-date-range-inline">{formatDateRange(event.startDate, event.endDate)}</span>
                    </div>
                  )}
                  <div className="event-name">{event.name}</div>
                  {event.type === 'project' && event.projectName && (
                    <div className="event-detail">{event.projectName}</div>
                  )}
                  {event.type === 'timeoff' && event.person && (
                    <div className="event-detail">{event.person}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmModal.open && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) closeConfirmModal() }}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <h2>{confirmModal.title}</h2>
            <p className="confirm-message">{confirmModal.message}</p>
            <div className="confirm-actions">
              <button className="secondary-btn" onClick={closeConfirmModal}>Cancel</button>
              <button
                className={`primary-btn${confirmModal.danger !== false ? ' danger-btn' : ''}`}
                onClick={async () => {
                  if (confirmModal.onConfirm) {
                    await confirmModal.onConfirm()
                  }
                }}
              >
                {confirmModal.confirmLabel || 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report Modal */}
      {reportModal.open && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setReportModal({ open: false, title: '', content: '' }) }}>
          <div className="modal report-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{reportModal.title}</h2>
              <div className="report-modal-actions">
                <button
                  className="report-modal-copy-btn"
                  onClick={() => {
                    copyRichText(reportModal.content).then(() => {
                      setCopiedReport(Date.now())
                      setTimeout(() => setCopiedReport(null), 2000)
                    })
                  }}
                >
                  <ClipboardCopy size={14} />
                  {copiedReport ? 'Copied!' : 'Copy'}
                </button>
                <button className="modal-close-btn" onClick={() => setReportModal({ open: false, title: '', content: '' })}>×</button>
              </div>
            </div>
            <div className="modal-body">
              {reportModal.richContent || <pre className="report-modal-content">{reportModal.content}</pre>}
            </div>
          </div>
        </div>
      )}

      {/* Capacity Help Modal */}
      {showCapacityHelp && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowCapacityHelp(false) }}>
          <div className="modal capacity-help-modal" onClick={e => e.stopPropagation()}>
            <div className="capacity-help-header">
              <h2>How Capacity Calculations Work</h2>
              <button className="capacity-help-close" onClick={() => setShowCapacityHelp(false)}>×</button>
            </div>
            <div className="capacity-help-content">
              <h3>Utilization Gauge</h3>
              <p>Shows what percentage of the team's total quarterly hours are allocated to active projects.</p>
              <ul>
                <li><strong>Available hrs</strong> — Each designer's weekly hours (default 35h) × 13 weeks in the quarter. Excluded designers are omitted.</li>
                <li><strong>Allocated hrs</strong> — Sum of each designer's allocation percentages × their weekly hours × 13 weeks. Only active and in-review projects count.</li>
                <li><strong>Remaining hrs</strong> — Available minus allocated. Red if negative (over-capacity).</li>
              </ul>
              <p>Gauge color: green ≤ 85%, amber 85–100%, red &gt; 100%.</p>

              <h3>Project Funding</h3>
              <p>Shows what percentage of estimated project work is covered by current designer allocations.</p>
              <ul>
                <li><strong>Estimated hrs</strong> — Sum of T-shirt size estimates (XXS=35h through XXL=910h) across all active/in-review projects.</li>
                <li><strong>Allocated hrs</strong> — For each assignment: designer's allocated hours/week × total project duration in weeks (start to end date). Projects without both dates are excluded.</li>
                <li><strong>Funded %</strong> — Allocated ÷ estimated. 100% means allocations fully cover the estimates.</li>
              </ul>
              <p>Bar color: green ≥ 90%, amber 60–89%, red &lt; 60%.</p>

              <h3>Weekly Load Heatmap</h3>
              <p>Shows each designer's allocated hours per week across the current DJ fiscal quarter.</p>
              <ul>
                <li><strong>Quarter</strong> — DJ fiscal year: Q1 Jul–Sep, Q2 Oct–Dec, Q3 Jan–Mar, Q4 Apr–Jun.</li>
                <li><strong>Week hours</strong> — For each week, sums the allocated hours from all active projects whose date range (or timeline phases) overlaps that week.</li>
                <li><strong>Colors</strong> — Green ≤ 60%, light green 61–80%, amber 81–100%, red &gt; 100% of the designer's weekly hours.</li>
                <li><strong>Current week</strong> — Highlighted with a black outline.</li>
                <li><strong>Dot marker</strong> — A small dot below a week cell indicates a project ending that week.</li>
              </ul>

              <h3>Per-Project Allocation Summary</h3>
              <p>Shown below each project chip, compares assigned effort to the T-shirt estimate.</p>
              <ul>
                <li><strong>Designers × hrs/wk × project weeks</strong> — Total effort the assigned team will produce over the project duration.</li>
                <li><strong>Over-allocated</strong> — Total effort exceeds estimate by &gt; 20%.</li>
                <li><strong>Under-allocated</strong> — Total effort is less than 50% of estimate.</li>
              </ul>

              <h3>Designer Chip Sections</h3>
              <ul>
                <li><strong>Active</strong> — Projects being worked on. Hours count toward utilization.</li>
                <li><strong>In Review</strong> — Projects in review. Hours still count toward utilization but chips are grouped separately.</li>
                <li><strong>Blocked</strong> — Hours set to 0, do not count toward utilization.</li>
                <li><strong>Done</strong> — Completed. Hours set to 0, do not count.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Search Modal */}
      {showSearch && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) { setShowSearch(false); setSearchQuery(''); setSearchResults({ projects: [], team: [], businessLines: [], notes: [] }); } }}>
          <div className="modal search-modal search-modal-v2" onClick={e => e.stopPropagation()}>
            {/* Search Header with Close */}
            <div className="search-modal-header">
              <div className="search-input-container">
                <Search size={20} className="search-input-icon" />
                <input
                  type="text"
                  className="search-input-v2"
                  placeholder="Search anything..."
                  value={searchQuery}
                  onChange={e => handleSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <button
                className="search-close-btn"
                onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults({ projects: [], team: [], businessLines: [], notes: [] }); }}
              >
                ×
              </button>
            </div>

            {/* Results */}
            <div className="search-results-v2">
              {searchQuery.length < 2 ? (
                <div className="search-empty-state">
                  <Search size={40} className="search-empty-icon" />
                  <p>Search projects, team, brands, and notes</p>
                  <span className="search-empty-hint">Type at least 2 characters to start</span>
                </div>
              ) : searchLoading ? (
                <div className="search-empty-state">
                  <div className="search-loading-indicator" />
                  <p>Searching...</p>
                </div>
              ) : filteredResults.projects.length === 0 && filteredResults.team.length === 0 && filteredResults.businessLines.length === 0 && filteredResults.notes.length === 0 ? (
                <div className="search-empty-state">
                  <p className="search-no-results">No results for "{searchQuery}"</p>
                  <span className="search-empty-hint">Try a different term or check spelling</span>
                </div>
              ) : (
                <>
                  {filteredResults.projects.length > 0 && (
                    <div className="search-result-group">
                      <div className="search-group-header">
                        <LayoutGrid size={14} />
                        <span>Projects</span>
                      </div>
                      {filteredResults.projects.map(project => (
                        <div key={project.id} className="search-result-card">
                          <div 
                            className="search-result-main"
                            onClick={() => { 
                              setActiveTab('projects'); 
                              setProjectFilters({ businessLines: [], designers: [], statuses: [], project: project.name || null }); 
                              setProjectSortBy('name'); 
                              setShowSearch(false); 
                              setSearchQuery(''); 
                            }}
                          >
                            <div className="search-result-title">{project.name}</div>
                            <div className="search-result-subtitle">
                              {project.designers?.join(', ')} • {project.businessLines?.join(', ')}
                            </div>
                          </div>
                          {project.matchedLinks && project.matchedLinks.length > 0 && (
                            <div className="search-result-links">
                              {project.matchedLinks.map((link, idx) => (
                                <a
                                  key={idx}
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="search-result-link"
                                  onClick={e => e.stopPropagation()}
                                >
                                  <LinkIcon size={12} />
                                  <span>{link.name}</span>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {filteredResults.team.length > 0 && (
                    <div className="search-result-group">
                      <div className="search-group-header">
                        <Users size={14} />
                        <span>Team</span>
                      </div>
                      {filteredResults.team.map(member => (
                        <div 
                          key={member.id} 
                          className="search-result-card search-result-card-team"
                          onClick={() => { 
                            setActiveTab('team'); 
                            setShowSearch(false); 
                            setSearchQuery(''); 
                          }}
                        >
                          <div className="search-result-avatar">
                            {member.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                          </div>
                          <div className="search-result-info">
                            <div className="search-result-title">{member.name}</div>
                            <div className="search-result-subtitle">
                              {member.role} • {member.brands?.slice(0, 3).join(', ')}
                              {member.brands?.length > 3 && ` +${member.brands.length - 3}`}
                            </div>
                          </div>
                          <div className={`search-result-status ${member.status}`} />
                        </div>
                      ))}
                    </div>
                  )}

                  {filteredResults.businessLines.length > 0 && (
                    <div className="search-result-group">
                      <div className="search-group-header">
                        <Folder size={14} />
                        <span>Business Lines</span>
                      </div>
                      {filteredResults.businessLines.map(bl => (
                        <div key={bl.id} className="search-result-card">
                          <div
                            className="search-result-main"
                            onClick={() => {
                              setActiveTab('settings');
                              setShowSearch(false);
                              setSearchQuery('');
                            }}
                          >
                            <div className="search-result-title">{bl.name}</div>
                          </div>
                          {bl.matchedLinks && bl.matchedLinks.length > 0 && (
                            <div className="search-result-links">
                              {bl.matchedLinks.map((link, idx) => (
                                <a
                                  key={idx}
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="search-result-link"
                                  onClick={e => e.stopPropagation()}
                                >
                                  <LinkIcon size={12} />
                                  <span>{link.name}</span>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {filteredResults.notes.length > 0 && (
                    <div className="search-result-group">
                      <div className="search-group-header">
                        <StickyNote size={14} />
                        <span>Notes</span>
                      </div>
                      {filteredResults.notes.map(note => (
                        <div key={note.id} className="search-result-card"
                          onClick={async () => {
                            setActiveTab('reports')
                            setShowSearch(false)
                            setSearchQuery('')
                            // Ensure notes are loaded first (need full note data with linkedProjectIds/linkedTeamIds)
                            let loadedNotes = notes
                            if (notes.length === 0) {
                              try {
                                const res = await authFetch('/api/notes')
                                const data = await res.json()
                                setNotes(data)
                                loadedNotes = data
                              } catch (err) {
                                console.error('Error loading notes:', err)
                              }
                            }
                            // Find the matching note from loaded notes (has full data)
                            const fullNote = loadedNotes.find((n: Note) => n.id === note.id) || note
                            setSelectedNote(fullNote)
                          }}
                        >
                          <div className="search-result-main">
                            <div className="search-result-title">{note.title || 'Untitled Note'}</div>
                            <div className="search-result-sub">
                              {note.date && (
                                <span>{note.date.length === 8 ? `${note.date.slice(0,4)}-${note.date.slice(4,6)}-${note.date.slice(6,8)}` : note.date}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

          </div>
        </div>
      )}

      {/* Business Line Modal */}
      {showBusinessLineModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowBusinessLineModal(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingBusinessLine ? 'Edit Business Line' : 'Add Business Line'}</h2>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Name</label>
                <input
                  id="bl-name"
                  type="text"
                  value={businessLineFormData.name}
                  onChange={e => setBusinessLineFormData({ ...businessLineFormData, name: e.target.value })}
                  placeholder="e.g., WSJ, Barron's, IBD"
                />
              </div>

              <div className="form-group">
                <label>Custom Links (max 3)</label>
                {businessLineFormData.customLinks?.map((link, idx) => (
                  <div key={idx} className="custom-link-row">
                    <input
                      type="text"
                      value={link.name}
                      onChange={e => {
                        const newLinks = [...businessLineFormData.customLinks];
                        newLinks[idx].name = e.target.value;
                        setBusinessLineFormData({ ...businessLineFormData, customLinks: newLinks });
                      }}
                      placeholder="Link name"
                    />
                    <input
                      type="url"
                      value={link.url}
                      onChange={e => {
                        const newLinks = [...businessLineFormData.customLinks];
                        newLinks[idx].url = e.target.value;
                        setBusinessLineFormData({ ...businessLineFormData, customLinks: newLinks });
                      }}
                      placeholder="https://..."
                    />
                    <button
                      type="button"
                      className="remove-link-btn"
                      onClick={() => {
                        const newLinks = businessLineFormData.customLinks.filter((_, i) => i !== idx)
                        setBusinessLineFormData({ ...businessLineFormData, customLinks: newLinks })
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {(
                  <button
                    type="button"
                    className="add-link-btn"
                    onClick={() => {
                      const newLinks = [...(businessLineFormData.customLinks || []), { name: '', url: '' }];
                      setBusinessLineFormData({ ...businessLineFormData, customLinks: newLinks });
                    }}
                  >
                    + Add Custom Link
                  </button>
                )}
              </div>

              {/* Images */}
              {editingBusinessLine && (
                <div className="form-section">
                  <div className="form-section-title">Images</div>
                  <div
                    className={`project-image-drop${uploadingBlImage ? ' uploading' : ''}`}
                    onPaste={async (e) => {
                      const items = e.clipboardData?.items
                      if (!items) return
                      for (const item of Array.from(items)) {
                        if (item.type.startsWith('image/')) {
                          e.preventDefault()
                          const file = item.getAsFile()
                          if (file) await uploadBlImage(editingBusinessLine.id, file, file.name || 'pasted-image.png')
                          return
                        }
                      }
                    }}
                    onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('dragover') }}
                    onDragLeave={e => e.currentTarget.classList.remove('dragover')}
                    onDrop={async (e) => {
                      e.preventDefault()
                      e.currentTarget.classList.remove('dragover')
                      const files = e.dataTransfer?.files
                      if (!files) return
                      for (const file of Array.from(files)) {
                        if (file.type.startsWith('image/')) {
                          await uploadBlImage(editingBusinessLine.id, file, file.name)
                        }
                      }
                    }}
                    tabIndex={0}
                  >
                    {uploadingBlImage && <div className="project-image-uploading"><Loader size={14} className="spin" /> Uploading...</div>}
                    {!uploadingBlImage && blImages.length === 0 && (
                      <div className="project-image-placeholder">Paste or drag an image here</div>
                    )}
                    {blImages.length > 0 && (
                      <div className="project-image-grid">
                        {blImages.map((img, idx) => (
                          <div key={img.id} className="project-image-item">
                            <div className="project-image-thumb">
                              <img src={`/api/images/${img.id}`} alt={img.caption || img.original_name} loading="lazy"
                                onClick={() => setLightbox({ images: blImages, index: idx })} />
                              <button className="project-image-delete" onClick={() => deleteBlImage(img.id)} title="Delete image">
                                <Trash2 size={12} />
                              </button>
                            </div>
                            <input className="project-image-caption" placeholder="Add caption..."
                              defaultValue={img.caption || ''}
                              onBlur={e => { if (e.target.value !== (img.caption || '')) updateBlImageCaption(img.id, e.target.value) }} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setShowBusinessLineModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={async () => {
                if (!businessLineFormData.name.trim()) return
                const lineToSave: BusinessLine = {
                  id: editingBusinessLine?.id || Date.now().toString(),
                  name: businessLineFormData.name,
                  customLinks: businessLineFormData.customLinks
                }
                await saveBusinessLine(lineToSave, editingBusinessLine?.name)
                setShowBusinessLineModal(false)
              }}>
                {editingBusinessLine ? 'Save Changes' : 'Add Business Line'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Modal */}
      {showUserModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowUserModal(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add User</h2>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  value={userFormData.email}
                  onChange={e => setUserFormData({ ...userFormData, email: e.target.value })}
                  placeholder="user@example.com"
                />
              </div>

              <div className="form-group">
                <label>Role</label>
                <select
                  value={userFormData.role}
                  onChange={e => setUserFormData({ ...userFormData, role: e.target.value })}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <div className="form-group">
                <label>Default Password</label>
                <input
                  type="text"
                  value="dj_wandihub!"
                  disabled
                  className="disabled-input"
                />
                <small style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                  User will need to change password on first login
                </small>
              </div>
            </div>

            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setShowUserModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={handleCreateUser}>
                Add User
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hide Note PIN Modal */}
      {showHideNotePinModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) setShowHideNotePinModal(false) }}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <h2>Hide Note</h2>
            <div className="pin-input-container">
              <input
                type="password"
                className="pin-input"
                placeholder="Enter PIN"
                value={hideNotePin}
                onChange={e => setHideNotePin(e.target.value)}
                maxLength={4}
                autoFocus
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && hideNotePin === '8432') {
                    if (noteToHide) {
                      try {
                        const res = await authFetch(`/api/notes/${noteToHide.id}/hide`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ pin: hideNotePin })
                        })
                        if (res.ok) {
                          setNotes(notes.filter(n => n.id !== noteToHide.id))
                          setShowHideNotePinModal(false)
                          setEditingNote(null)
                          setNoteToHide(null)
                          setHideNotePin('')
                        } else {
                          const err = await res.json()
                          alert(`Error: ${err.error}`)
                        }
                      } catch (err) {
                        console.error('Error hiding note:', err)
                        alert('Error hiding note')
                      }
                    }
                  }
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="secondary-btn" onClick={() => { setShowHideNotePinModal(false); setNoteToHide(null); setHideNotePin(''); }}>
                Cancel
              </button>
              <button 
                className="danger-btn" 
                onClick={async () => {
                  if (hideNotePin !== '8432') {
                    alert('Invalid PIN')
                    return
                  }
                  if (noteToHide) {
                    try {
                      const res = await authFetch(`/api/notes/${noteToHide.id}/hide`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pin: hideNotePin })
                      })
                      if (res.ok) {
                        setNotes(notes.filter(n => n.id !== noteToHide.id))
                        setShowHideNotePinModal(false)
                        setEditingNote(null)
                        setNoteToHide(null)
                        setHideNotePin('')
                      } else {
                        const err = await res.json()
                        alert(`Error: ${err.error}`)
                      }
                    } catch (err) {
                      console.error('Error hiding note:', err)
                      alert('Error hiding note')
                    }
                  }
                }}
              >
                Hide Note
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden Notes Unlock PIN Modal */}
      {showHiddenNotesPinModal && (
        <div className="modal-overlay" onMouseDown={e => { overlayMouseDownTarget.current = e.target }} onClick={e => { if (e.target === e.currentTarget && overlayMouseDownTarget.current === e.currentTarget) { setShowHiddenNotesPinModal(false); setHiddenNotesPin(''); } }}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <h2>Unlock Hidden Notes</h2>
            <div className="pin-input-container">
              <input
                type="password"
                className="pin-input"
                placeholder="Enter PIN"
                value={hiddenNotesPin}
                onChange={e => setHiddenNotesPin(e.target.value)}
                maxLength={4}
                autoFocus
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && hiddenNotesPin === '8432') {
                    try {
                      const res = await  authFetch('/api/notes?includeHidden=true')
                      const allNotes = await res.json()
                      const hidden = allNotes.filter((n: Note) => n.hidden === 1)
                      setHiddenNotes(hidden)
                      setHiddenNotesUnlocked(true)
                      setShowHiddenNotesPinModal(false)
                      setHiddenNotesPin('')
                    } catch (err) {
                      console.error('Error loading hidden notes:', err)
                    }
                  }
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="secondary-btn" onClick={() => { setShowHiddenNotesPinModal(false); setHiddenNotesPin(''); }}>
                Cancel
              </button>
              <button 
                className="primary-btn" 
                onClick={async () => {
                  if (hiddenNotesPin !== '8432') {
                    alert('Invalid PIN')
                    return
                  }
                  try {
                    const res = await  authFetch('/api/notes?includeHidden=true')
                    const allNotes = await res.json()
                    const hidden = allNotes.filter((n: Note) => n.hidden === 1)
                    setHiddenNotes(hidden)
                    setHiddenNotesUnlocked(true)
                    setShowHiddenNotesPinModal(false)
                    setHiddenNotesPin('')
                  } catch (err) {
                    console.error('Error loading hidden notes:', err)
                  }
                }}
              >
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
    {lightbox && (
      <ImageLightbox
        images={lightbox.images}
        currentIndex={lightbox.index}
        onClose={() => setLightbox(null)}
        onNavigate={index => setLightbox(prev => prev ? { ...prev, index } : null)}
      />
    )}
    </>
  )
}

export default App