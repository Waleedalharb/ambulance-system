# Agent Shared Contract - منصة الجنوب Refactoring

## المشروع
- المسار: `C:\Users\a7bk-\Documents\kimi\workspace\ambulance-dispatch`
- Stack: Node.js + Express + SQLite (sqlite3) + Vanilla HTML/CSS/JS
- اللغة: JavaScript (commonjs), CSS, HTML (Arabic/RTL)

## المهمة الأساسية
إعادة هندسة المشروع: JSON files → SQLite + تقسيم index.html + نقل النماذج للـ API

## المستخدمين والأدوار
- admin: كل الصلاحيات
- director: إدارة المناوبات، الوثائق، العمليات
- user: قراءة فقط

## الـ JWT
- JWT_SECRET: من process.env.JWT_SECRET
- JWT_EXPIRES_IN: '24h'
- BCRYPT_SALT_ROUNDS: 10
- الـ Middleware: `authenticate` و `authorize` موجودة في server.js

## الأدوات المشتركة
- `authenticate`: middleware يتحقق من JWT
- `authorize(['admin', 'director'])`: middleware يتحقق من الدور
- `addAuditLog(action, details, userId, username)`: دالة تسجل العمليات
- `broadcast(data)`: دالة ترسل WebSocket لجميع المتصلين

## البيانات الجغرافية (المراكز والفرق)
```js
const centersData = {
    "المنصورة": ["جنوب 1", "جنوب 11", "جنوب 12", "سريع 3"],
    "الخالدية": ["جنوب 2"],
    "منفوحة": ["جنوب 3"],
    "الدار البيضاء": ["جنوب 4", "جنوب 5", "سريع 1"],
    "الإسكان": ["جنوب 6"],
    "الحائر": ["جنوب 7"],
    "ديراب": ["جنوب 10"],
    "عكاظ": ["جنوب 9"],
    "الشفاء": ["جنوب 8", "سريع 2"],
    "الفرق الإضافية": ["سريع 4", "جنوب 13", "جنوب 14", "جنوب 15", "جنوب 16", "جنوب 17", "جنوب 18", "جنوب 19"]
};
```

## المسارات المشتركة للـ Storage
```js
const STORAGE_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
```

## البيانات الجغرافية للمراكز (hardcoded في server.js)
- `centerGeoData` في server.js يحتوي على إحداثيات كل فرقة
- `getDistance(lat1, lon1, lat2, lon2)` موجودة في server.js
- `/api/center-geo` و `/api/locate-report` موجودة

## الـ APIs الموجودة (ما يتغير)
- `/api/auth/*` - المصادقة
- `/api/users/*` - إدارة المستخدمين
- `/api/data` - بيانات البلاغات
- `/api/report` - تسجيل بلاغ
- `/api/undo` - تراجع عن بلاغ
- `/api/shifts/*` - المناوبات
- `/api/workforce-stats/:shiftId` - إحصائيات القوى العاملة
- `/api/docs/*` - المستندات
- `/api/get-identity` / `/api/upload-identity` / `/api/download-identity`
- `/api/air-ambulance/*` - الإسعاف الجوي
- `/api/control-notes/*` - ملاحظات التحكم
- `/api/vacations/*` - الإجازات
- `/api/get-password` / `/api/change-password`
- `/api/peak-data/*` - وقت الذروة
- `/api/upload-theme` / `/api/theme-settings` / `/api/remove-theme`
- `/api/center-geo` / `/api/locate-report`
- `/api/upload-monthly-table` / `/api/get-monthly-table` / `/api/check-monthly-table`
- `/api/export` - تصدير CSV
- `/api/upload-operational` / `/api/operational-files` / `/api/download-operational/:id` / `/api/delete-operational/:id`
- `/api/sound-settings/:userId`
- `/api/audit-log/*`

## الـ APIs الجديدة المطلوبة (النماذج)
جميعها تتطلب `authenticate` و `authorize(['admin', 'director'])` للـ POST/DELETE

### نموذج E (حالات توقف قلب وتنفس)
```
POST   /api/e-reports        { reportNumber, dateTime, location, age, gender, unit, responseTime, hospital, outcome, notes }
GET    /api/e-reports
DELETE /api/e-reports/:id
```

### بلاغ حادث (Incident)
```
POST   /api/incident-reports  { reportNumber, dateTime, location, incType, injuries, deaths, unit, hospital, details }
GET    /api/incident-reports
DELETE /api/incident-reports/:id
```

### بلاغ تصعيد (Escalation)
```
POST   /api/escalation-reports { reportNumber, dateTime, location, eventType, injuries, deaths, agencies, details }
GET    /api/escalation-reports
DELETE /api/escalation-reports/:id
```

### تقرير يومي (Daily Report)
```
POST   /api/daily-reports      { reportNumber, date, responseTeams, air, borderReports, paths, formFill, summary }
GET    /api/daily-reports
DELETE /api/daily-reports/:id
```

## جداول SQLite المطلوبة

### reports (البلاغات - بدل ambulance-data.json)
```sql
CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    center TEXT NOT NULL,
    unit TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
*ملاحظة: البلاغات الحالية تُخزن كـ key-value (center|unit → count + times). في SQLite نخزن كل بلاغ كـ record منفصل.*

### report_times (تواريخ البلاغات)
```sql
CREATE TABLE report_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER REFERENCES reports(id),
    timestamp TEXT NOT NULL
);
```

### shifts (المناجب - بدل shift-data.json)
```sql
CREATE TABLE shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_name TEXT NOT NULL,
    shift_date TEXT,
    shift_time TEXT,
    shift_type TEXT,
    start_time TEXT,
    total_reports INTEGER DEFAULT 0,
    rapid_locations TEXT,
    centers_data TEXT,
    general_notes TEXT,
    last_update TEXT
);
```

### shift_reports (البلاغات المحفوظة في المناوبة)
```sql
CREATE TABLE shift_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER REFERENCES shifts(id),
    center TEXT,
    unit TEXT,
    count INTEGER DEFAULT 0,
    times TEXT
);
```

### users (المستخدمين - بدل users.json)
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    role TEXT CHECK(role IN ('admin', 'director', 'user')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT,
    last_login TEXT
);
```

### audit_logs (سجل العمليات)
```sql
CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id TEXT UNIQUE,
    action TEXT,
    details TEXT,
    user_id TEXT,
    username TEXT,
    timestamp TEXT
);
```

### e_reports (حالات E)
```sql
CREATE TABLE e_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date_time TEXT,
    location TEXT,
    age INTEGER,
    gender TEXT,
    unit TEXT,
    response_time INTEGER,
    hospital TEXT,
    outcome TEXT,
    notes TEXT,
    created_at TEXT
);
```

### incident_reports (بلاغات الحوادث)
```sql
CREATE TABLE incident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date_time TEXT,
    location TEXT,
    inc_type TEXT,
    injuries INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    unit TEXT,
    hospital TEXT,
    details TEXT,
    created_at TEXT
);
```

### escalation_reports (بلاغات التصعيد)
```sql
CREATE TABLE escalation_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date_time TEXT,
    location TEXT,
    event_type TEXT,
    injuries INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    agencies TEXT,
    details TEXT,
    created_at TEXT
);
```

### daily_reports (التقارير اليومية)
```sql
CREATE TABLE daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date TEXT,
    response_teams INTEGER DEFAULT 0,
    air INTEGER DEFAULT 0,
    border_reports TEXT,
    paths TEXT,
    form_fill TEXT,
    summary TEXT,
    created_at TEXT
);
```

### air_ambulance_records (الإسعاف الجوي - بدل air-ambulance.json)
```sql
CREATE TABLE air_ambulance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT UNIQUE,
    report_number TEXT,
    unit TEXT,
    hospital TEXT,
    date_time TEXT,
    notes TEXT,
    created_at TEXT
);
```

### peak_data (وقت الذروة - بدل peak-data.json)
```sql
CREATE TABLE peak_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT UNIQUE,
    location TEXT,
    lat REAL,
    lng REAL,
    unit TEXT,
    start_time TEXT,
    end_time TEXT,
    priority TEXT,
    notes TEXT,
    status TEXT DEFAULT 'نشط',
    created_at TEXT
);
```

### peak_alerts
```sql
CREATE TABLE peak_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT UNIQUE,
    title TEXT,
    details TEXT,
    priority TEXT,
    unit TEXT,
    location TEXT,
    start_time TEXT,
    end_time TEXT,
    notes TEXT,
    lat REAL,
    lng REAL,
    radius INTEGER DEFAULT 5000,
    mission_id TEXT,
    status TEXT DEFAULT 'نشط',
    created_at TEXT
);
```

### peak_logs
```sql
CREATE TABLE peak_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id TEXT UNIQUE,
    icon TEXT,
    action TEXT,
    details TEXT,
    priority TEXT,
    time TEXT,
    date TEXT,
    created_at TEXT
);
```

### control_notes (ملاحظات التحكم)
```sql
CREATE TABLE control_notes (
    id INTEGER PRIMARY KEY,
    notes TEXT,
    updated_at TEXT
);
```

### vacations (إجازات التحكم)
```sql
CREATE TABLE vacations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    start_date TEXT,
    end_date TEXT,
    type TEXT,
    created_at TEXT
);
```

### docs (التحديثات التشغيلية)
```sql
CREATE TABLE docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT UNIQUE,
    filename TEXT,
    file_data TEXT,
    file_type TEXT,
    description TEXT,
    category TEXT,
    priority TEXT,
    uploader TEXT,
    upload_date TEXT
);
```

### sound_settings
```sql
CREATE TABLE sound_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    enabled INTEGER DEFAULT 1,
    volume REAL DEFAULT 0.5,
    updated_at TEXT
);
```

### theme_settings
```sql
CREATE TABLE theme_settings (
    id INTEGER PRIMARY KEY,
    file_type TEXT,
    file_name TEXT,
    logo_file_name TEXT,
    logo_file_type TEXT,
    updated_at TEXT
);
```

### password_settings
```sql
CREATE TABLE password_settings (
    id INTEGER PRIMARY KEY,
    password TEXT,
    updated_at TEXT
);
```

## قواعد عامة
- الحفاظ على كل APIs الموجودة ( backwards compatible )
- استخدام SQLite فقط (بدون JSON files)
- استخدام async/await مع sqlite3
- استخدام prepared statements دائماً
- الحفاظ على اللغة العربية في جميع الردود
- الحفاظ على مصادقة JWT
- addAuditLog لكل عملية مهمة
- broadcast لكل تحديث فوري (WebSocket)

## الملفات التي لا يجوز تعديلها
- `public/sw.js` - Service Worker
- `public/manifest.json` - PWA manifest
- `public/icons/*` - الأيقونات
- `public/favicon.ico/*` - Favicon
- `public/uploads/*` - الملفات المرفوعة
- `render.yaml` - إعداد Render
- `README.md` - الوصف
- `data/backups/*` - النسخ الاحتياطية

## الملفات التي يمكن تعديلها
- `server.js` - إضافة APIs ونقل لـ SQLite
- `public/index.html` - تقسيم وإزالة inline CSS/JS
- `public/css/app.css` - استخراج CSS (جديد)
- `public/js/app.js` - استخراج JS (جديد)
- `public/forms/*.html` - تحديث لتستخدم APIs بدل localStorage
- `db/database.js` - SQLite wrapper (جديد)
- `db/migrate.js` - Migration script (جديد)
- `package.json` - إضافة sqlite3 dependency
- `.gitignore` - إضافة database.db
