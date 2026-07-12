import json
import urllib.request
import urllib.error

# Configuration
BASE_URL = "http://127.0.0.1:3004"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImVtcC1hZG1pbiIsInVzZXJuYW1lIjoiYWRtaW4iLCJuYW1lIjoi2YXYr9mK2LEg2KfZhNmG2LjYp9mFIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzgzNjQ3MjcyLCJleHAiOjE3ODM3MzM2NzJ9.8G2M8nWxcTwU9wPbM_DPh6IvBxLt-VvmLJVt9OGVtq0"

def api_get(endpoint):
    req = urllib.request.Request(
        f"{BASE_URL}{endpoint}",
        headers={"Authorization": f"Bearer {TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"Error {e.code}: {e.read().decode()}")
        return None
    except Exception as e:
        print(f"Error: {e}")
        return None

print("=" * 60)
print("  منصة الجنوب - بيانات المؤشرات التنفيذية")
print("=" * 60)
print()

# Executive Dashboard
exec_data = api_get("/api/shifts/executive-dashboard")
if exec_data and exec_data.get("success"):
    d = exec_data.get("daily", {})
    w = exec_data.get("weekly", {})
    m = exec_data.get("monthly", {})
    print(f"📊 اليوم:")
    print(f"   المناوبات: {d.get('total_shifts', 0)}")
    print(f"   البلاغات:  {d.get('total_reports', 0)}")
    print(f"   نسبة الإنجاز: {d.get('completion_rate', 0)}%")
    print()
    print(f"📊 الأسبوع:")
    print(f"   المناوبات: {w.get('total_shifts', 0)}")
    print(f"   البلاغات:  {w.get('total_reports', 0)}")
    print(f"   نسبة الإنجاز: {w.get('completion_rate', 0)}%")
    print()
    print(f"📊 الشهر:")
    print(f"   المناوبات: {m.get('total_shifts', 0)}")
    print(f"   البلاغات:  {m.get('total_reports', 0)}")
    print(f"   نسبة الإنجاز: {m.get('completion_rate', 0)}%")
    print()
    
    top = exec_data.get("top_centers", [])
    if top:
        print("🏥 أكثر المراكز بلاغات:")
        for c in top[:5]:
            print(f"   {c['name']}: {c['count']} بلاغ")
    print()
    
    alerts = exec_data.get("alerts", [])
    if alerts:
        print(f"⚠️  التنبيهات ({len(alerts)}):")
        for a in alerts[:3]:
            print(f"   [{a.get('severity','')}] {a.get('message','')}")
    else:
        print("✅ لا توجد تنبيهات")
    print()

# Monthly Dashboard
month_data = api_get("/api/shifts/monthly-dashboard?month=7&year=2026")
if month_data and month_data.get("success"):
    print("=" * 60)
    print("  المؤشرات الشهرية - يوليو 2026")
    print("=" * 60)
    print(f"   المناوبات:        {month_data.get('total_shifts', 0)}")
    print(f"   البلاغات:         {month_data.get('total_reports', 0)}")
    print(f"   ساعات التشغيل:    {month_data.get('total_operating_hours', 0)}")
    print(f"   الموظفين:         {month_data.get('total_staff', 0)}")
    print(f"   الفرق:            {month_data.get('total_teams', 0)}")
    print(f"   المركبات:         {month_data.get('total_vehicles', 0)}")
    print(f"   مناوبات صباحية:   {month_data.get('morning_shifts', 0)}")
    print(f"   مناوبات ليلية:    {month_data.get('night_shifts', 0)}")
    print(f"   نسبة الإنجاز:     {month_data.get('completion_rate', 0)}%")
    print(f"   متوسط الأداء:     {month_data.get('avg_performance', 0)}")
    print()

# Daily Dashboard for a sample day
day_data = api_get("/api/shifts/daily-dashboard?date=3/7/2026")
if day_data and day_data.get("success"):
    print("=" * 60)
    print("  المؤشرات اليومية - 3/7/2026")
    print("=" * 60)
    print(f"   المناوبات:        {day_data.get('total_shifts', 0)}")
    print(f"   البلاغات:         {day_data.get('total_reports', 0)}")
    print(f"   المكتملة:         {day_data.get('completed_reports', 0)}")
    print(f"   المعلقة:          {day_data.get('open_reports', 0)}")
    print(f"   المراكز:          {day_data.get('total_teams', 0)}")
    print(f"   نسبة الإنجاز:     {day_data.get('completion_rate', 0)}%")
    print(f"   أكثر مركز:        {day_data.get('top_center', '—')}")
    print()

print("=" * 60)
print("  للمشاهدة في المتصفح:")
print(f"  {BASE_URL}/shift-executive-dashboard.html")
print("=" * 60)
