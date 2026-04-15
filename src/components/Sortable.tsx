import { useSortable } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Pencil, Trash2 } from 'lucide-react'
import type { Project, TimelineRange } from '../types'
import { parseLocalDate, formatShortDate, calcRangeHours } from '../utils'

export function SortablePriorityItem({
  project,
  rank,
}: {
  project: Project
  rank: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const statusColors: Record<string, string> = { active: '#3b82f6', review: '#f59e0b', done: '#22c55e', blocked: '#ef4444', archived: '#78716c' }
  const statusLabel: Record<string, string> = { active: 'Active', review: 'In Review', done: 'Done', blocked: 'Blocked', archived: 'Archived' }
  const isOverdue = (() => {
    if (!project.endDate || project.status === 'done') return false
    const end = parseLocalDate(project.endDate)
    if (!end) return false
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    return end < today
  })()

  return (
    <div ref={setNodeRef} style={style} className="priority-item">
      <button type="button" className="action-btn drag-handle" {...attributes} {...listeners} tabIndex={-1}>
        <GripVertical size={14} />
      </button>
      <span className="priority-rank">{rank}</span>
      <div className="priority-info">
        <span className="priority-name">{isOverdue && <span className="overdue-label">Overdue</span>}{isOverdue && ' '}{project.name}</span>
        <span className="priority-meta">
          {project.designers?.join(', ') || '—'}
          {project.endDate ? ` · ${formatShortDate(project.endDate)}` : ''}
        </span>
      </div>
      <span className="priority-status-label" style={{ color: statusColors[project.status] || '#94a3b8' }}>
        <span className="priority-status-dot" style={{ background: statusColors[project.status] || '#94a3b8' }} />
        {statusLabel[project.status] || project.status}
      </span>
    </div>
  )
}

export function SortableDoneItem({
  project,
}: {
  project: Project
}) {
  const sortableId = `done:${project.id}`
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const statusColors: Record<string, string> = { active: '#3b82f6', review: '#f59e0b', done: '#22c55e', blocked: '#ef4444', archived: '#78716c' }
  const statusLabel: Record<string, string> = { active: 'Active', review: 'In Review', done: 'Done', blocked: 'Blocked', archived: 'Archived' }
  const isOverdue = (() => {
    if (!project.endDate || project.status === 'done') return false
    const end = parseLocalDate(project.endDate)
    if (!end) return false
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    return end < today
  })()

  return (
    <div ref={setNodeRef} style={style} className="priority-item unranked">
      <button type="button" className="action-btn drag-handle" {...attributes} {...listeners} tabIndex={-1}>
        <GripVertical size={14} />
      </button>
      <span className="priority-rank-empty">—</span>
      <div className="priority-info">
        <span className="priority-name">{isOverdue && <span className="overdue-label">Overdue</span>}{isOverdue && ' '}{project.name}</span>
        <span className="priority-meta">{project.designers?.join(', ') || '—'}</span>
      </div>
      <span className="priority-status-label" style={{ color: statusColors[project.status] }}>
        <span className="priority-status-dot" style={{ background: statusColors[project.status] }} />
        {statusLabel[project.status]}
      </span>
    </div>
  )
}

export function SortableTimelineItem({
  range,
  onEdit,
  onDelete,
}: {
  range: TimelineRange
  onEdit: (r: TimelineRange) => void
  onDelete: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: range.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} className="timeline-item">
      <button type="button" className="action-btn drag-handle" {...attributes} {...listeners} tabIndex={-1}>
        <GripVertical size={14} />
      </button>
      <div className="timeline-info">
        <span className="timeline-name">{range.name}</span>
        <span className="timeline-dates">{formatShortDate(range.startDate)} → {formatShortDate(range.endDate)} · {calcRangeHours(range.startDate, range.endDate)} hrs</span>
      </div>
      <div className="timeline-actions">
        <button type="button" className="action-btn" onClick={() => onEdit(range)}><Pencil size={14} /></button>
        <button type="button" className="action-btn delete" onClick={() => onDelete(range.id)}><Trash2 size={14} /></button>
      </div>
    </div>
  )
}

export function InProgressDropZone({ children, id, isDraggingFromDone }: { children?: React.ReactNode; id: string; isDraggingFromDone: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`priority-in-progress-zone${isOver && isDraggingFromDone ? ' drop-active' : ''}`}>
      <div className="priority-zone-label">In Progress</div>
      <div className="priority-list">
        {children}
      </div>
    </div>
  )
}

export function DoneDropZone({ children, id = 'done-drop-zone' }: { children?: React.ReactNode; id?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`priority-done-drop${isOver ? ' drop-active' : ''}`}
    >
      <span className="priority-done-drop-label">{isOver ? 'Drop to mark done' : 'Done'}</span>
      {children}
    </div>
  )
}
