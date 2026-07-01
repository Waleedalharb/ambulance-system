# Peak Time System Redesign Plan (نظام وقت الذروة الجديد)

## Current State Analysis
- `peakTimeModal` - Basic form modal (location, unit, time, priority, notes)
- `peakMapModal` - Leaflet map for location selection
- `peakAlertModal` - Alert popup with countdown, map, and rating
- JS: basic save/load via API, countdown timer, map initialization
- Missing: team classification, plan types, real-time dashboard, heat map, AI dispatch, archive, notifications

## New System Architecture

### Stage 1: HTML Structure (index.html)
- Replace `peakTimeModal` with a comprehensive dashboard modal
- New sections: Plans, Teams, Dashboard, Map, Archive
- Keep `peakMapModal` for map selection
- Keep `peakAlertModal` with enhancements

### Stage 2: CSS (app.css)
- New peak-time specific CSS classes
- Countdown timer styles (green/yellow/red transitions)
- Team status cards
- Dashboard grid layouts
- Heat map legend styles
- Responsive design for the dashboard

### Stage 3: JavaScript (app.js)
- **Local Storage**: Store all peak data locally (no API dependency for core features)
- **Deployment Plans**: Create/edit/delete plans with types
- **Team Classification**: Advanced, basic, rapid response, field commander, support
- **Countdown System**: Visual countdown with progress bar and color changes
- **Team Confirmation**: Arrival/departure with timestamps and notes
- **Real-time Dashboard**: Active, late, arrived, departed teams
- **Heat Map**: Visualize incident density (using existing Leaflet)
- **AI Dispatch**: Simple distance-based suggestions
- **Archive**: Search, filter, export to CSV
- **Notifications**: Sound alerts + reminders (30, 15, 5 min before)
- **Auto-backup**: Suggest alternative team if primary unavailable

## Implementation Order
1. New HTML modal structure
2. New CSS styles
3. Core JS: data models, storage, plan CRUD
4. Team management + classification
5. Countdown + confirmation system
6. Dashboard + real-time tracking
7. Heat map visualization
8. Archive + export
9. Notifications + sound alerts
10. AI dispatch suggestions

## Data Models
```js
peakPlans = [
  { id, title, type, startTime, endTime, location, lat, lng, status, createdAt }
]
peakAssignments = [
  { id, planId, unitId, teamType, status, arrivalTime, departureTime, notes }
]
peakTeamTypes = ['advanced', 'basic', 'rapid', 'commander', 'support']
peakPlanTypes = ['peak', 'event', 'temporary', 'incident', 'emergency']
```
