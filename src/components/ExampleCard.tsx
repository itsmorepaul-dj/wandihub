import { Pencil, Trash2, ExternalLink } from 'lucide-react'

interface ExampleCardProps {
  title: string
  status: 'active' | 'review' | 'done' | 'blocked' | 'archived'
  designers?: string[]
  businessLine?: string
  onEdit?: () => void
  onDelete?: () => void
  onOpen?: () => void
}

const statusConfig: Record<string, { label: string; dotClass: string }> = {
  active: { label: 'Active', dotClass: 'bg-blue-500' },
  review: { label: 'In Review', dotClass: 'bg-yellow-500' },
  done: { label: 'Done', dotClass: 'bg-green-500' },
  blocked: { label: 'Blocked', dotClass: 'bg-red-500' },
  archived: { label: 'Archived', dotClass: 'bg-stone-500' },
}

export function ExampleCard({
  title,
  status,
  designers = [],
  businessLine,
  onEdit,
  onDelete,
  onOpen,
}: ExampleCardProps) {
  const { label, dotClass } = statusConfig[status] || statusConfig.active

  return (
    <div className="example-card">
      <div className="example-card-header">
        <div className="example-card-title">{title}</div>
        <span className="status-badge">
          <span className={`status-badge-dot ${dotClass}`} />
          {label}
        </span>
      </div>

      {(businessLine || designers.length > 0) && (
        <div className="example-card-meta">
          {businessLine && <span className="example-card-bl">{businessLine}</span>}
          {designers.length > 0 && (
            <span className="example-card-designers">
              {designers.join(', ')}
            </span>
          )}
        </div>
      )}

      <div className="example-card-actions">
        {onOpen && (
          <button className="action-btn" onClick={onOpen} title="Open">
            <ExternalLink size={14} />
          </button>
        )}
        {onEdit && (
          <button className="action-btn" onClick={onEdit} title="Edit">
            <Pencil size={14} />
          </button>
        )}
        {onDelete && (
          <button className="action-btn delete" onClick={onDelete} title="Delete">
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
