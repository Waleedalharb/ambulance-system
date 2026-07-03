# Smart Shift Management System — Plan

## Overview
Build an intelligent shift scheduling engine for EMS operations that auto-generates schedules, detects shortages, and proposes alternative coverage. Integrates with existing `shift_roster`, `employees`, `teams`, `shift_codes` tables.

## Architecture

### Database Schema Additions

1. **`leave_requests` table** — Employee leave requests
2. **`shift_schedule_auto` table** — Auto-generated schedule entries with metadata
3. **`staffing_alerts` table** — Shortage alerts and recommendations

### Core Algorithm (Smart Scheduler)

**Normal Mode (12h shifts):**
- 10 employees, pattern: 2 days + 2 nights + 4 off (8-day cycle)
- Each shift: 2 employees minimum
- 2 shifts/day (day + night) = 4 employees per day
- 2 employees on leave max at any time
- Leaves reduce to minimum 8 operational staff

**Alternative Mode (8h shifts):**
- Trigger: < 8 operational staff available
- 3 employees per 8h shift = 3 shifts/day = 9 slots total
- May assign individual coverage per shift
- Re-balance across all slots

**Ambulance Team Rules:**
- Team = 2 paramedics minimum (cannot operate with 1)
- If a team has < 2 staff → station closed, recommend transfer
- Extra paramedic → assign to Rapid Response / Quick Intervention
- Visual: Red = closed, Yellow = under-staffed, Green = fully staffed

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/shift-schedule/generate` | POST | Generate monthly schedule |
| `/api/shift-schedule/month` | GET | Get schedule for month/year |
| `/api/shift-schedule/update` | POST | Update single assignment |
| `/api/shift-schedule/staffing` | GET | Staffing levels with indicators |
| `/api/leave-requests` | GET/POST | List / submit leave requests |
| `/api/leave-requests/:id` | PUT/DELETE | Update / cancel |
| `/api/leave-requests/:id/approve` | POST | Approve/Deny |
| `/api/staffing-alerts` | GET | Active shortage alerts |
| `/api/staffing-recommendations` | GET | Auto-suggested coverage plans |

### Frontend (smart-schedule.html)

1. **Dashboard Widgets** (top of page):
   - Available employees count
   - On leave count
   - Current shortage status (green/yellow/red badge)
   - Upcoming risks (next 3 days)

2. **Schedule Grid** (main):
   - Calendar-style month view
   - Each cell: employees assigned per shift
   - Color coding by shift type
   - Click to edit

3. **Staffing Panel** (sidebar):
   - Visual indicators per day: green/yellow/red
   - Detailed breakdown per shift
   - Recommended actions

4. **Leave Management Tab**:
   - Submit request form
   - Pending requests list (admin view)
   - Approval actions

5. **Alternative Mode Toggle**:
   - Auto-detect shortage → suggest alternative
   - One-click apply recommended coverage

## Implementation Stages

### Stage 1: Database Schema + API (server.js + db.js)
- Add tables, seed data
- Build scheduling engine algorithm
- Implement all endpoints
- Add WebSocket broadcasts

### Stage 2: Frontend Dashboard (smart-schedule.html)
- Dashboard widgets
- Schedule grid with drag/drop
- Staffing indicators
- Leave request form
- Alternative mode UI

### Stage 3: Integration + Testing
- Wire frontend to backend
- Test edge cases
- Deploy

## Skills Needed
- `vibecoding-webapp-swarm` (not installed) → Orchestrator designs
- No report-writing needed — this is a feature implementation
- No docx needed — deliverable is code

## Sub-agent Assignments

### Worker 1: Database + API Backend
- Add schema to db.js (leave_requests, shift_schedule_auto, staffing_alerts)
- Add CRUD endpoints to server.js
- Build scheduling algorithm
- Leave request workflow
- Staffing analysis engine

### Worker 2: Frontend Dashboard + Schedule Grid
- smart-schedule.html enhancements
- Dashboard widgets (available, on-leave, shortage indicators)
- Month-view calendar grid with employees
- Color coding, drag/drop, click-to-edit
- Leave request tab
- Alternative mode UI

### Worker 3: Smart Scheduling Engine (algorithm-only)
- Pure scheduling algorithm
- Normal mode: 12h cycle generator
- Alternative mode: 8h rebalancer
- Ambulance team constraint solver
- Conflict detection
- Recommendations engine
- Returns JSON schedule + recommendations

## File Outputs
- `db.js` — updated with new tables
- `server.js` — updated with new endpoints
- `public/smart-schedule.html` — updated/enhanced
- `public/js/smart-schedule.js` — new file (schedule logic)
- `public/css/smart-schedule.css` — new file (styles)
