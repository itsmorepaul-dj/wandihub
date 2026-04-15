export interface TimelineRange {
  id: string
  name: string
  startDate: string
  endDate: string
}

export interface Project {
  id: string
  name: string
  description?: string
  url?: string
  status: 'active' | 'review' | 'done' | 'blocked' | 'pending' | 'archived'
  startDate?: string
  endDate?: string
  designers: string[]
  businessLines?: string[]
  deckName?: string
  deckLink?: string
  prdName?: string
  prdLink?: string
  briefName?: string
  briefLink?: string
  figmaLink?: string
  customLinks?: { name: string; url: string }[]
  matchedLinks?: { name: string; url: string; type?: string }[]
  timeline: TimelineRange[]
  estimatedHours?: number
  archivedQuarter?: string | null
}

export interface BusinessLine {
  id: string
  name: string
  deckName?: string
  deckLink?: string
  prdName?: string
  prdLink?: string
  briefName?: string
  briefLink?: string
  figmaLink?: string
  customLinks?: { name: string; url: string }[]
  matchedLinks?: { name: string; url: string; type?: string }[]
}

export interface TeamMember {
  id: string
  name: string
  role: string
  brands: string[]
  status: 'online' | 'away' | 'offline'
  slack?: string
  email?: string
  timeOff?: { name: string; startDate: string; endDate: string; id: string }[]
}

export interface Note {
  id: string
  source_id?: number
  source_filename?: string
  title: string
  date?: string
  content_preview?: string
  people_raw?: string
  projects_raw?: string
  drive_url?: string
  source_created_at?: string
  created_at?: string
  updated_at?: string
  linkedProjectIds: string[]
  linkedTeamIds: string[]
  next_steps?: string
  details?: string
  attachments?: string
  hidden?: number
  hidden_at?: string
}

export interface CalendarEvent {
  type: 'project' | 'timeoff' | 'holiday'
  name: string
  person?: string
  projectName?: string
  startDate?: string
  endDate?: string
  color?: string
}

export interface CalendarDay {
  day: number
  date: string
  dayName: string
  events: CalendarEvent[]
}

export interface CalendarMonth {
  name: string
  year: number
  month: number
  days: CalendarDay[]
}

export interface CalendarData {
  months: CalendarMonth[]
}

export interface CapacityMember {
  id: string
  name: string
  weekly_hours?: number
  excluded?: boolean
}

export interface CapacityAssignment {
  id: string
  project_id: string
  designer_id: string
  allocation_percent?: number
  project_name?: string
  designer_name?: string
  project_status?: string
  businessLine?: string
}

export interface CapacityData {
  team: CapacityMember[]
  assignments: CapacityAssignment[]
}

export interface ActivityItem {
  id: number
  category: string
  action: string
  target_name: string
  user_email: string
  details: string | null
  created_at: string
}

export interface WeeklyUpdate {
  id: string
  project_id: string
  designer_id: string
  week: string
  type: 'highlight' | 'lowlight'
  description: string
  risk_reason?: string
  resolution?: string
  created_at?: string
  updated_at?: string
  designer_name?: string
  project_name?: string
  business_lines?: string
}

export interface WeeklyGeneral {
  id: string
  designer_id: string
  week: string
  category: 'fyi' | 'people'
  content: string
  created_at?: string
  updated_at?: string
  designer_name?: string
}

export interface ProjectImage {
  id: string
  project_id: string
  filename: string
  original_name: string
  mime_type: string
  size_bytes: number
  caption: string
  created_at: string
}

export type TabId = 'projects' | 'team' | 'calendar' | 'capacity' | 'reports' | 'reviews' | 'settings'
