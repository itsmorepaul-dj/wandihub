// Source of truth for "What's new" entries shown in Settings → General.
// Add new entries to the TOP of this list. Format: { date: "YYYY-MM-DD", entry: "..." }.
// Dates are interpreted in local time. The modal groups by date and paginates
// by ISO week (Mon-Sun), so a single date appears on exactly one page.

// `time` is optional HHMM (24-hour, e.g. "1851"). New entries should set it
// at deploy time so the Settings → General "View changelog" link can show a
// fully-stamped YYYY.MM.DD HHMM matching site_version / db_version.
// Historical entries without a time fall back to YYYY.MM.DD.
export type ChangelogEntry = { date: string; time?: string; entry: string }

export const CHANGELOG: ChangelogEntry[] = [
  { date: "2026-06-01", time: "1223", entry: "New \"Draft\" project status (fuchsia) for early-stage work you're not ready to share widely. Draft projects appear in full to design team members and admins, but everyone else sees a placeholder (\"Draft project: [business line]\") with the name, description, links, and weekly notes hidden — across project lists, capacity, reviews, reports, weekly snapshots, and activity." },
  { date: "2026-06-01", time: "1103", entry: "Fixed weekly updates that wouldn't save (and reports that wouldn't open) when your sign-in had quietly expired — the app now keeps your typed text safe and shows a \"Sign in again\" prompt instead of failing silently, so you no longer need to be on VPN for saves to stick." },
  { date: "2026-06-01", time: "1103", entry: "Fixed the project \"Needs update\" badge staying red after you'd already saved a weekly update on weekends and Monday mornings — it now correctly flips to \"Updated\" the moment you save." },
  { date: "2026-05-28", time: "1034", entry: "Public review site has a clearer left nav: Design Hub logo at the top links home, weeks are labeled by date range (e.g. \"May 25 – 31\"), Weekly Crits are pinned with a star, the redundant \"Weekly Crit / Quick Crits\" subheaders are gone, the active item gets an accent left bar, and the review pages now use a dark red Design Hub favicon to match the review numbering." },
  { date: "2026-05-27", time: "2228", entry: "Settings access UI now matches reality: any @dowjones.com employee can sign in as a Viewer automatically (no admin needed), so the request flow has been relabeled around role upgrades — \"Access Requests\" is now \"Role Upgrade Requests,\" the read-only toast asks for \"edit access,\" and the User Accounts section explains how the auto-Viewer onboarding works." },
  { date: "2026-05-27", time: "2153", entry: "Faster Capacity tab — the per-request integrity sweep now runs once at startup instead of on every load, removing hundreds of redundant SQLite round-trips before the page renders." },
  { date: "2026-05-27", time: "2053", entry: "Settings → \"View changelog\" replaces the sign-in popover — opens a full history modal with week-by-week navigation; the link itself shows the latest deploy stamp." },
  { date: "2026-05-27", time: "2053", entry: "Fresh blue Design Hub favicon in browser tabs." },
  { date: "2026-05-27", time: "2053", entry: "Cleaner public project URLs — capability suffixes are gone now that the site is behind the firewall (existing public links have been backfilled too)." },
  { date: "2026-05-27", time: "2053", entry: "Anyone hitting the old wandihub.up.railway.app address now sees a \"We've moved\" page with an 8-second redirect to the matching Design Hub URL (deep links preserved)." },
  { date: "2026-05-27", time: "1851", entry: "Fresh Design Hub logo across the site." },
  { date: "2026-05-27", time: "1851", entry: "Multi-day special days: pick a start and end date when adding a holiday and Settings groups them into a single range row." },
  { date: "2026-05-27", time: "1851", entry: "Slow tabs (Capacity, Calendar, Reviews) now show a loading overlay if they take longer than a second to render." },
  { date: "2026-05-27", time: "1851", entry: "Admins can now \"View as\" a User or Viewer from Settings to test role-gated features without logging out." },
  { date: "2026-05-27", time: "1851", entry: "Maintenance mode polish: rebranded lockout screen with ETA messaging, public review/published links stay live, support pings #designhub-access, and admins can lock out instantly (0 minutes)." },
  { date: "2026-05-27", time: "1851", entry: "Access requests submitted via the external request form now create pending viewer accounts automatically." },
  { date: "2026-05-26", entry: "New home: WandiHub is now Design Hub, hosted on the Dow Jones internal platform. Sign in with your DJ Okta account — no separate password needed. Bookmark the new URL: https://designhub.hatch.ai.dowjones.io" },
  { date: "2026-05-26", entry: "Fixed: review images now load on Design Hub." },
  { date: "2026-05-26", entry: "Admins can now change a user's role (User ↔ Admin) directly from Settings → User Accounts." },
  { date: "2026-05-26", entry: "User Accounts: redesigned as a compact table showing each person's name (from Okta) and email, with role and delete inline." },
  { date: "2026-05-26", entry: "New \"Viewer\" role gives read-only access — viewers can browse everything and post review comments, but cannot edit projects, capacity, notes, or other data." },
  { date: "2026-05-26", entry: "New people signing in via Okta now start as viewers — read-only by default until an admin promotes them." },
  { date: "2026-05-26", entry: "Viewers can press \"Request access\" on the read-only toast to ask an admin for full access. Admins see a persistent banner at the top of the site listing pending requests." },
  { date: "2026-05-26", entry: "User Accounts now has a search field to filter the list by name, email, or role." },
  { date: "2026-05-20", entry: "Public review cards now show a chip for each project's business line next to the status badge." },
  { date: "2026-05-15", entry: "New: A customized weekly executive report reformats the raw status inputs from active projects and general info into concise bites of important information grouped by business line." },
  { date: "2026-05-15", entry: "Polish: Executive Summary report uses the same look as View Report, links render correctly, project names link back to a filtered project view, and Docs copy/paste lays out cleanly with bullets stripped and projects spaced apart." },
  { date: "2026-05-14", entry: "Fix: \"View Report\" on the Weekly Status card no longer logs you out." },
  { date: "2026-05-14", entry: "Fix: Weekly Status report now opens correctly when a project has only an FYI or People note (no highlight or lowlight) for the week." },
  { date: "2026-05-13", entry: "Description fields now carry full RTE formatting — bold and bullets render correctly alongside links on the public review pages, bare URLs like \"google.com\" are treated as \"https://\" automatically, and selecting bold text before adding a link now keeps the bold formatting on the link." },
  { date: "2026-05-12", entry: "Project descriptions now render formatting — bold, bullets, and links from the description editor toolbar display properly in the project list instead of showing raw markdown." },
  { date: "2026-05-12", entry: "Publishing controls moved to the project card — every project now has a \"Make public\" chip that publishes + copies the URL in one click, and the green \"Published\" chip opens a dropdown to either open the public page or unpublish. The separate \"Published Project Pages\" card on the Reports tab has been removed." },
  { date: "2026-05-12", entry: "Fixed lightbox on public project pages — clicking an attached image on a Published project's public URL now opens the full-size lightbox with caption, counter, and keyboard navigation, matching behavior on review pages." },
  { date: "2026-05-12", entry: "Weekly Status report thumbnails now open the standard lightbox — clicking a project image in a Weekly Status report (live or from a past snapshot) opens the same in-app lightbox with caption, counter, and keyboard navigation used elsewhere, instead of opening the raw image in a new tab." },
  { date: "2026-05-12", entry: "Weekly report no longer shows stale content — \"View Report\" is now filtered to only live, non-archived projects, and deleting a project now cascades through weekly updates, images, notes, and review history so orphaned data can no longer surface. A one-time cleanup also wipes pre-existing orphans from the database." },
  { date: "2026-05-12", entry: "Faster and cleaner Weekly Status report — \"View Report\" opens immediately instead of doing copy-to-Docs prep on open, jump-nav links no longer pull up a project page behind the modal, and the report is strictly filtered to the current reporting week so leftover content from prior weeks no longer surfaces. Clearing a field in Optional General Notes and saving now deletes that entry directly (no separate Delete button or confirm modal)." },
  { date: "2026-05-12", entry: "Weekly Status report overhaul — \"View Report\" opens faster and only shows the current reporting week's content (archived-project and older-week leftovers are cleaned out, including a one-time sweep of pre-existing orphans). Deleting a project now cascades through weekly updates, images, notes, and review history so nothing can orphan again. Jump-nav links stay inside the modal instead of pulling up a project page behind it. Optional General Notes now has a one-click \"Upcoming OOO\" suggester on the People tab, Risk and Resolution fields on the Lowlights tab (rendered with the same vertical red bar as project lowlights in the report and Docs export), and editing a field clears/saves it directly (no separate Delete button or confirm modal). Report thumbnails open the standard in-app lightbox." },
  { date: "2026-05-12", entry: "Weekly update status badge on project cards — every active, in-review, or blocked project now shows a small red \"Needs update\" or green \"Updated\" pill next to the weekly-update toggle so it's obvious at a glance whether the project has an entry for the current reporting week." },
  { date: "2026-05-11", entry: "Weekly snapshot no longer shows duplicated highlights, lowlights, or FYIs. Duplicate submissions are now prevented at the database layer, the snapshot generator dedupes defensively, and existing duplicate rows were cleaned up." },
  { date: "2026-05-11", entry: "Weekly reports have a new, cleaner layout grouped by business line, and you can now copy them straight into Google Docs with full formatting." },
  { date: "2026-05-11", entry: "Your weekly update text sticks around week to week — edit instead of rewriting. The snapshot now locks at Friday 8pm ET, and you have until Monday noon ET to regenerate the latest report with late edits." },
  { date: "2026-05-11", entry: "Upcoming time off shows up automatically — any time off scheduled within 10 days is added to the People section of the weekly report, so you don't have to type it in." },
  { date: "2026-05-11", entry: "Weekly report got a redesign — reports are now grouped by business line, copy straight into Google Docs with full formatting, and the \"View Report\" preview matches the frozen snapshot exactly." },
  { date: "2026-05-11", entry: "Your weekly text sticks around — your weekly update text carries over week to week so you can edit instead of rewriting; the snapshot locks at Friday 8pm ET and you have until Monday noon ET to pull in late edits." },
  { date: "2026-05-11", entry: "Stay signed in across deploys — your login now survives a code push, so you won't get bounced to the login screen every time a new version ships." },
  { date: "2026-05-06", entry: "Reviews tab polish — the review selector and public sidebar now show each review's actual title, the Gemini-notes field is tucked in a collapsed accordion so it can't be mistaken for the description, and meta controls (date, time, copy link, delete) sit right under the title row." },
  { date: "2026-05-06", entry: "Mark one formal \"Weekly Crit\" per week — a new checkbox on the review edit page pins that review to the top of the public review sidebar (in bold) under \"Weekly Crit\", with any others that week listed below under \"Quick Crits\". One per week, enforced." },
  { date: "2026-05-06", entry: "Add-to-review picker is now a searchable modal (same pattern as Reports → Publish a project) instead of a long dropdown." },
  { date: "2026-05-06", entry: "Public review sidebar gets Week subsections with thin dividers between weeks." },
  { date: "2026-05-04", entry: "Drag-and-drop images from your computer into the public review page — filenames with emoji or accents now upload cleanly, and dropping slightly off the target no longer bounces you to the image." },
  { date: "2026-05-04", entry: "Public review sidebar shows each review's actual title (wrapping when it's long) instead of a generic \"Week N\"." },
  { date: "2026-05-04", entry: "Weekly-update reminders now include the designer's first name so admins can tell identical-looking rows apart." },
  { date: "2026-04-29", entry: "Change a project's status directly from the review edit page — click the status chip on any row to flip it between Active, In Review, Done, Blocked, or Pending without leaving the review." },
  { date: "2026-04-29", entry: "Removed reviews and projects can be brought back — deleting a review or pulling a project out of a review now sends it to \"Recently removed\" (linked next to the review selector), where you can restore everything with its notes, comments, and images intact." },
  { date: "2026-04-28", entry: "Weekly updates now save explicitly — a Save button and status indicator replace the invisible auto-save, and closing the tab with unsaved changes warns you before leaving. Your FYIs and People entries are now attributed to you (the signed-in user) so nothing gets filed under a co-designer." },
  { date: "2026-04-28", entry: "Weekly Status report card shows when the snapshot was last frozen and warns when live entries are newer. Admins can regenerate the current week on demand from the card." },
  { date: "2026-04-28", entry: "Weekly updates stay yours — entries on shared projects no longer get filed under a co-designer, and FYI/People rows can't be wiped by a teammate's save." },
  { date: "2026-04-28", entry: "Real Save button — explicit save with status chip, tab-switch auto-save, and an unload warning if you'd lose work." },
  { date: "2026-04-28", entry: "Weekly Status snapshot — status bar shows when the report was last frozen, flags newer entries, and anyone can regenerate it on demand." },
  { date: "2026-04-28", entry: "Small polish — Deck/PRD/Brief/Figma chips removed from the editor toolbar, and card buttons only click on the button, not the whole row." },
  { date: "2026-04-28", entry: "Review page polish — adding a project flips it to In Review, the confirm modal closes after removing a project, and the comments-this-week list links straight to the filtered project." },
  { date: "2026-04-27", entry: "Published Project Pages — Share a project with stakeholders at a public, read-only URL from the Reports page. No sign-in required." },
  { date: "2026-04-27", entry: "Review diamonds filter — Clicking a Design Review diamond on any Gantt chart now opens the review scoped to that project. A pill at the top clears the filter." },
  { date: "2026-04-27", entry: "Published Project Pages — Share a project with stakeholders at a public, read-only URL from the Reports page. No sign-in required. Includes a design-time estimate chip with a t-shirt size legend." },
  { date: "2026-04-24", entry: "Your bell now only shows things you actually care about. If someone edits, archives, or comments on a project you're on, if your allocation changes, if your PTO gets edited, or if a new holiday is added — your bell lights up. Everything else stays out of your way. Admins still see the full activity history." },
  { date: "2026-04-24", entry: "Friendly reminders now land in your bell automatically: a nudge every Friday morning if you haven't filed your weekly update yet, a heads-up a week before any company holiday, and a three-day warning before your own PTO starts." },
  { date: "2026-04-24", entry: "On review pages, the comment box now grows as you type instead of scrolling sideways, and bullet points show up as real bullets instead of dashes." },
  { date: "2026-04-24", entry: "Attached images got a refresh. Project and review cards now have \"Add images\" / \"Edit images\" buttons that open a dedicated window for pasting, captioning, reordering, and deleting — with thumbnails in a scrollable row underneath." },
  { date: "2026-04-24", entry: "Image manager — Cards now have \"Add\" / \"Edit images\" buttons that open a window for pasting, captioning, reordering, and deleting." },
  { date: "2026-04-24", entry: "Comments & bullets — Review-page comment boxes grow as you type, and bullet points render as real bullets." },
  { date: "2026-04-24", entry: "Smarter bell — Alerts only for projects you're on, your allocation changes, your PTO edits, and new holidays. Admins still see everything." },
  { date: "2026-04-24", entry: "Auto reminders — Friday nudge if your weekly update is missing, a week's heads-up before holidays, and a three-day warning before your PTO." },
  { date: "2026-04-23", entry: "Review dates + copy to another review — each review now has an explicit review date (pick it when creating the review or edit it in the header), independent of when the review was created. Each project in a review has its own gallery of images, exclusive to that review — images added for Week 14 don't bleed into Week 15. Hover the copy icon on any review item for a tooltip; clicking it clones the item into another review, deep-copying notes, description, and image files so the two entries stay fully independent. All destructive actions (removing a project from a review, deleting project/business line images, clearing a weekly report section) now require confirmation first." },
  { date: "2026-04-23", entry: "Review dates, per-review image galleries, and copy-to-review — each review has its own date and each project in a review keeps its own exclusive images. Use the copy icon on any row to clone an item into another review (deep copy of notes and images). Destructive actions now confirm first, and the edit page is mobile-friendly." },
  { date: "2026-04-23", entry: "Review time planner — set a total meeting length; each project gets an auto-calculated time slot. Drag to rebalance, or mark a project \"Exempt\" to drop it into a \"For awareness…\" section." },
  { date: "2026-04-23", entry: "Gemini notes on reviews — paste Gemini-generated meeting notes from a Google Doc into the new field under the review description. Headings, bullets, bold, and links are preserved and appear on the public review page as a \"Gemini notes\" accordion above the project cards. Empty field = hidden." },
  { date: "2026-04-23", entry: "Per-project comment threads on the public review page — authenticated users can leave comments on any project in a review. Each comment is stamped with the user's name and time. Edit/delete your own; admins can moderate. Comments show up live across open tabs — no refresh needed." },
  { date: "2026-04-23", entry: "Personalized notifications — comments posted on your assigned projects now push to your notifications bell automatically, with the bell dot pulsing red/yellow until you check it. The Projects page shows a green \"X comments this week\" pill that respects whatever designer, business-line, or status filter you've applied; click it for a grouped summary that links straight to the review." },
  { date: "2026-04-22", entry: "Review time planner — set a total meeting length for each review; each project gets an auto-calculated time slot shown before its status. Drag the slider to give a project more or less time (others rebalance automatically), or mark a project \"Exempt\" — exempt projects drop to a \"For awareness…\" section at the bottom of the public page. Document links on the public page are now labeled (Design deck, PRD, Jira)." },
  { date: "2026-04-21", entry: "Public review site — reprioritized the project card for review: description and links lead, with the project schedule (gantt) collapsed into an \"Open Project Schedule\" accordion that matches the \"Open Notes\" treatment. Card numbers rendered as red circles with white text. Attached project links use a conventional blue color with underline so they read as clickable. Markdown links in descriptions and the review page header now render as clickable anchors instead of raw `[text](url)`. Uploaded images can be reordered via drag handle on each thumbnail in the notes panel, and the delete button now uses the same trash icon as the project edit modal." },
  { date: "2026-04-21", entry: "Filter-aware summary — the Projects summary stats and risk warnings now reflect the active sort/filter, so filtering by designer or business line scopes the counts to the visible subset. Moved below the sort/filter controls to reinforce that it reflects those settings. Archive button matched to the sort button height." },
  { date: "2026-04-21", entry: "Gantt review diamonds — Every project gantt now shows a blue diamond for each review that includes it, positioned by the review's week and linking straight to the public review page." },
  { date: "2026-04-21", entry: "Public review site — project cards reprioritized: description and blue underlined links lead, gantt collapsed into an \"Open Project Schedule\" accordion matching \"Open Notes\". Red circle card numbers, clickable markdown links, and drag-to-reorder for images in the notes panel." },
  { date: "2026-04-21", entry: "Filter-aware summary — Projects summary stats and risk warnings now scope to the active sort/filter, and sit below the controls. Archive button height matched to sort buttons." },
  { date: "2026-04-21", entry: "Gantt review diamonds — Project gantts now include a \"Design Review\" track row with a gold diamond for each review that includes the project, positioned by the review's week and linking to the public review page." },
  { date: "2026-04-21", entry: "Review site is more secure — shareable review links no longer carry login info in the URL, so copying and sharing a link won't expose your session." },
  { date: "2026-04-17", entry: "Review item descriptions — add an optional description per project in a review, visible on the public review page below the project header" },
  { date: "2026-04-17", entry: "Archive from board — archive projects directly from the status chip on project cards, no need to go through Settings" },
  { date: "2026-04-17", entry: "Weekly general updates — add general highlights, lowlights, FYIs, and people updates to the weekly status report from the Current Week panel in Reports" },
  { date: "2026-04-17", entry: "Rich text toolbar — bold, bullets with sub-bullet indentation, and links in all text fields. Report copy now pastes into Google Docs with formatting intact." },
  { date: "2026-04-17", entry: "Per-entry copy — copy individual entries in the weekly status report view with a clipboard icon on hover. Bullet toggle converts existing lines." },
  { date: "2026-04-15", entry: "Review descriptions — optional rich text field under the review title for adding summaries or context, visible on the public review page" },
  { date: "2026-04-15", entry: "Link insertion fix — highlighting text in review notes and adding a link now correctly replaces the selection instead of inserting at the beginning" },
  { date: "2026-04-15", entry: "Review item images — upload, caption, and delete images per review project in the Open Notes accordion, with lightbox viewing on the public review site" },
  { date: "2026-04-15", entry: "Archive status — archive projects directly from the project board with one click, placing them into the current fiscal quarter's archive" },
  { date: "2026-04-14", entry: "Business line images — add, caption, and delete images on business lines in settings, with thumbnails on the card" },
  { date: "2026-04-14", entry: "Archive & quarter management for all — restore projects and run quarter rollovers without needing admin" },
  { date: "2026-04-10", entry: "Pending status — new project status for not-yet-started work, grayed out in capacity like done, sorted last" },
  { date: "2026-04-10", entry: "W&I Open Critiques — redesigned report with review site notes, t-shirt sizing, per-designer icons, and full active project listing by business line" },
  { date: "2026-04-10", entry: "Review snapshots — automatic Tuesday 5pm ET reports with accordion history, matching the weekly status pattern" },
  { date: "2026-04-10", entry: "Concurrent edit protection — review site notes now detect conflicts when two people edit at the same time" },
  { date: "2026-04-10", entry: "Project descriptions — optional description field in the edit modal, displayed on project cards below the title" },
  { date: "2026-04-10", entry: "Duplicate from archive — duplicate an archived project directly into active without restoring it first" },
  { date: "2026-04-10", entry: "Weekly updates for all statuses — the weekly report accordion now appears on projects in any status, not just active/review/blocked" },
  { date: "2026-04-10", entry: "Multi-designer icon — project cards show the group icon when more than one designer is assigned" },
  { date: "2026-04-09", entry: "Visual refresh — refined color palette, layered shadows, tighter typography, smoother animations across the entire UI" },
  { date: "2026-04-09", entry: "Review agenda — create, navigate, and share public review pages with project status, designers, links, notes, and Gantt timelines" },
  { date: "2026-04-07", entry: "Weekly updates — add highlights, lowlights, FYIs, and people updates per project with inline links and bullet formatting" },
  { date: "2026-04-07", entry: "Weekly snapshots — auto-generated Friday 5pm ET reports with full history on the Reports page" },
  { date: "2026-04-07", entry: "Missing update warnings — projects page alerts for active projects without weekly updates" },
  { date: "2026-04-07", entry: "Archive by business line — archived projects now grouped by business line within each quarter" },
  { date: "2026-04-07", entry: "Improved warning badges — pill-style with tinted backgrounds for better readability in light and dark modes" },
  { date: "2026-04-07", entry: "Rich text editor — weekly update form now uses contentEditable with inline rendered links, no more edit/preview toggle" },
  { date: "2026-04-07", entry: "Improved link flow — select text, click link button, name pre-fills from selection, explicit Add Link button in popover" },
  { date: "2026-04-07", entry: "Project images — paste or drag images into projects, view in lightbox with captions and keyboard navigation" },
  { date: "2026-04-07", entry: "Card redesign — designers, hours, edit & delete moved to compact meta chips in header; attached images below links" },
  { date: "2026-04-07", entry: "Missing weekly updates warning — now always visible until all projects have entries, resets after weekly report" },
  { date: "2026-04-07", entry: "Bug fixes — fixed stale vacation icons, \"Unknown\" project names in reports, duplicate button, accordion double-click" },
  { date: "2026-04-06", entry: "Quarterly archive — archive done projects at quarter boundaries, browse and restore from archive" },
  { date: "2026-03-24", entry: "Click any calendar date to quickly add your time off — no need to open the full team modal" },
  { date: "2026-03-24", entry: "Fiscal year chart now shows month labels below each quarter bar" },
  { date: "2026-03-24", entry: "Migrated GitHub to internal Dow Jones repo" },
  { date: "2026-03-24", entry: "Migrated to new home — wandihub.up.railway.app" },
  { date: "2026-03-23", entry: "Codebase refactored — server split into modules, frontend types and utilities extracted" },
  { date: "2026-03-23", entry: "Deleted 9 deprecated sync scripts that could cause data corruption" },
  { date: "2026-03-21", entry: "Added background treatment to capacity page designer filters for visual consistency" },
  { date: "2026-03-19", entry: "Version guard prevents data loss from stale pages after deploys" },
  { date: "2026-03-19", entry: "Project risk warnings surface overdue, missing estimates, and ending-soon items" },
  { date: "2026-03-19", entry: "Clickable risk details with project links" },
  { date: "2026-03-19", entry: "Capacity mini arc gauges on designer cards" },
  { date: "2026-03-19", entry: "Responsive fiscal year timeline in capacity view" },
  { date: "2026-03-19", entry: "Unified project summary bar with status counts and risks" },
  { date: "2026-03-19", entry: "Normalized hover states across all filter components" },
  { date: "2026-03-19", entry: "Centralized DB write functions with startup schema validation — prevents silent data loss" },
  { date: "2026-03-19", entry: "Version guard blocks stale pages from writing to the database after deploys" },
  { date: "2026-03-19", entry: "Project risk warnings surface overdue, missing estimates, ending-soon, and multi-designer items" },
  { date: "2026-03-19", entry: "Clickable risk details with project links and human-readable dates" },
  { date: "2026-03-19", entry: "Fixed missing estimates risk showing 0 designers when designers are assigned via project form" },
]

// Local-time YYYY-MM-DD parser. Avoids the UTC interpretation that
// `new Date("YYYY-MM-DD")` triggers, which would otherwise shift the date
// by the local TZ offset.
function parseLocal(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day)
}

// Returns the Monday (00:00 local) of the ISO week containing `d`. Mon-Sun weeks.
function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = x.getDay()
  const back = dow === 0 ? 6 : dow - 1
  x.setDate(x.getDate() - back)
  return x
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function formatChangelogDate(dateStr: string): string {
  const d = parseLocal(dateStr)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
}

export function formatWeekRange(weekKey: string): string {
  const start = parseLocal(weekKey)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const sameYear = start.getFullYear() === end.getFullYear()
  const sameMonth = sameYear && start.getMonth() === end.getMonth()
  const startFmt = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endFmt = sameMonth
    ? end.toLocaleDateString('en-US', { day: 'numeric' })
    : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${startFmt} – ${endFmt}, ${end.getFullYear()}`
}

export function changelogWeekKeys(): string[] {
  const set = new Set<string>()
  for (const e of CHANGELOG) {
    set.add(isoDate(weekStart(parseLocal(e.date))))
  }
  return [...set].sort((a, b) => b.localeCompare(a))
}

export function mostRecentChangelogWeek(): string {
  const weeks = changelogWeekKeys()
  return weeks[0] || ''
}

// Returns the newest entry's stamp as `YYYY.MM.DD.HHMM` (or `YYYY.MM.DD` if
// the entry has no time). Suitable input for `formatVersionDisplay()` so the
// Settings link reads in the same shape as Site version / DB version.
export function latestChangelogStamp(): string {
  let best: ChangelogEntry | null = null
  let bestKey = ''
  for (const e of CHANGELOG) {
    const key = `${e.date}T${e.time || '0000'}`
    if (key > bestKey) { bestKey = key; best = e }
  }
  if (!best) return ''
  const datePart = best.date.replace(/-/g, '.')
  return best.time ? `${datePart}.${best.time}` : datePart
}

export function changelogForWeek(weekKey: string): { date: string; entries: string[] }[] {
  if (!weekKey) return []
  const start = parseLocal(weekKey)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  const groups = new Map<string, string[]>()
  for (const e of CHANGELOG) {
    const d = parseLocal(e.date)
    if (d >= start && d < end) {
      if (!groups.has(e.date)) groups.set(e.date, [])
      groups.get(e.date)!.push(e.entry)
    }
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({ date, entries }))
}
