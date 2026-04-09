# WandiHub Design System Reference

Use these tokens, classes, and patterns for ALL new features. Never invent new class names or hardcode colors.

## Design Tokens (CSS Custom Properties)

All colors, shadows, radii defined in `src/index.css`. Always use `var(--token-name)`.

### Backgrounds
| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--color-bg` | `#ffffff` | `#09090b` | Page background |
| `--color-bg-secondary` | `#f9fafb` | `#111113` | Cards, sidebar, sections |
| `--color-bg-tertiary` | `#f3f4f6` | `#1a1a1e` | Inset areas, gantt tracks |
| `--color-bg-elevated` | `#ffffff` | `#18181b` | Modals, popovers |
| `--color-bg-subtle` | `#f9fafb` | `#111113` | Subtle containers |

### Text
| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--color-text` | `#111827` | `#fafafa` | Primary text |
| `--color-text-secondary` | `#4b5563` | `#a1a1aa` | Secondary text |
| `--color-text-muted` | `#6b7280` | `#71717a` | Muted text, nav items, icons |
| `--color-text-dim` | `#9ca3af` | `#52525b` | Dim text, placeholders |
| `--color-text-link` | `#2563eb` | `#60a5fa` | Links |

### Accent & Semantic
| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--color-accent` | `#2563eb` | `#3b82f6` | Primary buttons, active nav, focus |
| `--color-accent-hover` | `#1d4ed8` | `#60a5fa` | Button hover |
| `--color-accent-subtle` | `rgba(37,99,235,0.08)` | `rgba(59,130,246,0.12)` | Accent backgrounds |
| `--color-success` | `#059669` | `#10b981` | Success states |
| `--color-warning` | `#d97706` | `#f59e0b` | Warning states |
| `--color-danger` | `#dc2626` | `#ef4444` | Danger/error states |

### Borders
| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--color-border` | `#e5e7eb` | `#27272a` | Default borders |
| `--color-border-subtle` | `#f3f4f6` | `#1e1e21` | Subtle/inner borders |
| `--color-border-hover` | `#d1d5db` | `#3f3f46` | Hover state borders |

### Overlays
| Token | Use |
|-------|-----|
| `--color-hover-subtle` | Row/card hover background |
| `--color-modal-overlay` | Modal backdrop |
| `--color-badge-bg` / `--color-badge-text` | Badge chips |

### Shadows
| Token | Use |
|-------|-----|
| `--shadow-xs` | Stat cards |
| `--shadow-sm` | Card hover |
| `--shadow-md` | Dropdowns |
| `--shadow-lg` | Panels |
| `--shadow-xl` | Modals |
| `--shadow-glow` | Input focus ring |

### Border Radius
| Token | Value | Use |
|-------|-------|-----|
| `--radius-xs` | `4px` | Tiny badges |
| `--radius-sm` | `6px` | Buttons, inputs, nav items |
| `--radius-md` | `10px` | Cards |
| `--radius-lg` | `14px` | Large containers |
| `--radius-xl` | `18px` | Modals |

---

## Reusable Component Classes

### Buttons

**`.primary-btn`** — Main CTA. Accent bg, white text, 600 weight, 0.8125rem.
```jsx
<button className="primary-btn" onClick={handler}>+ New Thing</button>
```

**`.secondary-btn`** — Cancel/secondary. Transparent bg, border, 500 weight.

**`.danger-btn`** — Destructive. Red bg, white text.

**`.icon-btn`** — 36x36 icon-only button with border.

**`.action-btn`** — 32x32 compact icon button. Add `.delete` for red hover.

**`.danger-btn-text`** — Text-only danger link (no background).

### Cards

All cards use: `background: var(--color-bg-secondary)`, `border: 1px solid var(--color-border)`, `border-radius: var(--radius-md)`.
Hover: `border-color: var(--color-border-hover)`, `box-shadow: var(--shadow-sm)`.

- **`.project-row`** — Project list card. Column flex. Padding via `.project-info`.
- **`.team-card`** — Team member card. Grid: `repeat(auto-fill, minmax(280px, 1fr))`.
- **`.review-card`** — Review card. Grid: `repeat(auto-fill, minmax(300px, 1fr))`.
- **`.capacity-stat-card`** — Stat card with large number.

### Chips & Pills

**`.project-meta-chip`** — Tiny pill (border-radius: 99px), 0.68rem, border.
```jsx
<span className="project-meta-chip">Label</span>
```

**`.project-meta-chip.project-meta-action`** — Clickable chip, hidden by default (opacity: 0), shown on parent `:hover`.
```jsx
<span className="project-meta-chip project-meta-action" onClick={handler}>
  <Pencil size={11} /> Edit
</span>
<span className="project-meta-chip project-meta-action project-meta-action-delete" onClick={handler}>
  <Trash2 size={11} /> Delete
</span>
```

**`.filter-pill`** — Toggle pill. Add `.active` for selected (accent bg, white text).

### Modals

Always use this structure:
```jsx
{showModal && (
  <div className="modal-overlay"
    onMouseDown={e => { overlayMouseDownTarget.current = e.target }}
    onClick={e => {
      if (e.target === overlayMouseDownTarget.current &&
          (e.target as HTMLElement).classList.contains('modal-overlay'))
        setShowModal(false)
    }}>
    <div className="modal" style={{ maxWidth: 520 }}>
      <div className="modal-header">
        <h2>Title</h2>
        <button className="modal-close-btn" onClick={() => setShowModal(false)}>&times;</button>
      </div>
      <div className="modal-body">
        {/* content */}
      </div>
      <div className="modal-actions" style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)' }}>
        <button className="secondary-btn" onClick={() => setShowModal(false)}>Cancel</button>
        <button className="primary-btn" onClick={handleSave}>Save</button>
      </div>
    </div>
  </div>
)}
```

Or use `<div className="modal-footer">` for right-aligned actions.

### Form Inputs

**`.float-field`** — Floating label input. Add `.has-value` when input has value.
```jsx
<div className={`float-field${value ? ' has-value' : ''}`}>
  <input type="text" value={value} onChange={handler} placeholder=" " />
  <label>Field Label</label>
</div>
```
- `placeholder=" "` is required for the CSS `:placeholder-shown` selector
- Focus: `border-color: var(--color-accent)`, `box-shadow: var(--shadow-glow)`

### Status

**`.status-dot`** — 10x10 circle, color set via inline style.
```jsx
<span className="status-dot" style={{ background: statusColors[status] }} />
```
Status color map: `{ active: '#3b82f6', review: '#f59e0b', done: '#22c55e', blocked: '#ef4444' }`

### Empty States

Use centered flex column with icon, heading, description:
```jsx
<div className="reviews-empty">
  <Icon size={40} strokeWidth={1.5} />
  <h3>Title</h3>
  <p>Description</p>
</div>
```
Colors: heading `var(--color-text-muted)`, description `var(--color-text-dim)`.

---

## Typography

- **Font:** `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif`
- **h1:** 1.375rem, weight 700, letter-spacing -0.025em
- **h2 (modal):** 1.0625rem, weight 600, letter-spacing -0.02em
- **Card titles:** 0.9rem, weight 600
- **Body:** 0.875rem
- **Buttons:** 0.8125rem, weight 600 (primary) / 500 (secondary)
- **Small labels:** 0.75rem
- **Table headers:** 0.65rem, uppercase, letter-spacing 0.06em, weight 600
- **Chips:** 0.68rem
- **Badges:** 0.65rem

---

## Rules

1. **Never hardcode colors.** Always use `var(--color-*)` tokens.
2. **Never invent new button classes.** Use `primary-btn`, `secondary-btn`, `danger-btn`, `icon-btn`, `action-btn`.
3. **Never invent new card patterns.** Follow `project-row` / `team-card` / `review-card` structure.
4. **Never invent new chip classes.** Use `project-meta-chip` + `project-meta-action`.
5. **Always use existing radius tokens** (`--radius-xs` through `--radius-xl`).
6. **Always use existing shadow tokens** (`--shadow-xs` through `--shadow-xl`, `--shadow-glow`).
7. **Modal structure is fixed.** Use `modal-overlay` > `modal` > `modal-header` + `modal-body` + `modal-footer`/`modal-actions`.
8. **Form inputs use `.float-field`** with `.has-value` toggle.
9. **For server-rendered pages** (like `/review/:id`), define local CSS variables that mirror the token system (prefixed `--rv-*`) with both light and dark values.
