# خطة التصميم الجديد - Modern SaaS Design

## الهوية البصرية الجديدة

### الألوان (Color Palette)
- Primary: #2563EB (Blue)
- Primary Dark: #1E40AF
- Primary Light: #DBEAFE
- Success: #10B981 (Emerald)
- Success Light: #D1FAE5
- Danger: #EF4444 (Red)
- Danger Light: #FEE2E2
- Warning: #F59E0B (Amber)
- Warning Light: #FEF3C7
- Info: #3B82F6 (Blue)
- Background: #F8FAFC (Slate 50)
- Surface: #FFFFFF
- Text Primary: #1E293B (Slate 800)
- Text Secondary: #64748B (Slate 500)
- Border: #E2E8F0 (Slate 200)

### الخطوط (Typography)
- Primary: 'IBM Plex Sans Arabic', 'Inter', -apple-system, sans-serif
- Mono: 'IBM Plex Mono', monospace
- Weights: 400, 500, 600, 700

### الظلال (Shadows)
- sm: 0 1px 2px rgba(0, 0, 0, 0.05)
- md: 0 4px 6px rgba(0, 0, 0, 0.07)
- lg: 0 10px 15px rgba(0, 0, 0, 0.1)
- xl: 0 20px 25px rgba(0, 0, 0, 0.1)

### الزوايا (Border Radius)
- sm: 6px
- md: 8px
- lg: 12px
- xl: 16px
- full: 9999px

### المكونات (Components)

#### الأزرار (Buttons)
- Primary: gradient from #2563EB to #3B82F6, white text, shadow
- Success: gradient from #10B981 to #34D399, white text
- Danger: gradient from #EF4444 to #F87171, white text
- Warning: gradient from #F59E0B to #FBBF24, dark text
- Secondary: #F1F5F9 background, #475569 text, border
- Ghost: transparent, hover background
- Border radius: 8px
- Padding: 10px 20px
- Font weight: 600
- Hover: translateY(-1px), enhanced shadow
- Active: translateY(0), scale(0.98)
- Transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1)

#### البطاقات (Cards)
- Background: white
- Border: 1px solid #E2E8F0
- Border radius: 12px
- Shadow: 0 1px 3px rgba(0,0,0,0.05)
- Hover: shadow 0 4px 12px rgba(0,0,0,0.08), translateY(-2px)
- Padding: 24px
- Transition: all 0.3s ease

#### الجداول (Tables)
- Header: #F8FAFC background, #64748B text, 600 weight
- Border: 1px solid #E2E8F0
- Border radius: 12px (overflow hidden)
- Row hover: #F8FAFC background
- Active row: #DBEAFE background, #2563EB right border
- Cell padding: 12px 16px
- Font size: 0.85rem
- Sticky header

#### النماذج (Forms)
- Input: 1px solid #E2E8F0, 8px radius, white bg
- Focus: #2563EB border, 0 0 0 3px rgba(37, 99, 235, 0.1)
- Label: 0.8rem, #475569, 600 weight
- Select: custom arrow icon
- Transition: all 0.2s ease

#### النوافذ المنبثقة (Modals)
- Overlay: rgba(15, 23, 42, 0.5), backdrop-filter blur(4px)
- Content: white, 16px radius, 0 20px 60px rgba(15,23,42,0.2) shadow
- Border: 1px solid #E2E8F0
- Animation: fadeIn 0.3s ease-out

#### الشارات (Badges)
- Primary: #DBEAFE bg, #2563EB text
- Success: #D1FAE5 bg, #10B981 text
- Danger: #FEE2E2 bg, #EF4444 text
- Warning: #FEF3C7 bg, #D97706 text
- Gray: #F1F5F9 bg, #64748B text
- Border radius: 9999px
- Padding: 4px 12px
- Font size: 0.75rem
- Font weight: 600

#### التبويبات (Tabs)
- Container: #F1F5F9 bg, 8px radius, 4px padding
- Tab: transparent, #64748B text
- Active: white bg, #2563EB text, shadow-sm
- Hover: #475569 text
- Transition: all 0.2s ease

#### التنبيهات (Alerts)
- Success: #D1FAE5 bg, #059669 text, #10B981 border
- Warning: #FEF3C7 bg, #D97706 text, #F59E0B border
- Danger: #FEE2E2 bg, #DC2626 text, #EF4444 border
- Info: #DBEAFE bg, #2563EB text, #3B82F6 border
- Border radius: 8px
- Padding: 12px 16px
- Icon: left side

### الحركات (Animations)
- fadeIn: opacity 0→1, translateY(8px→0), 0.3s ease-out
- slideIn: translateX(20px→0), 0.3s ease-out
- scaleIn: scale(0.95→1), opacity 0→1, 0.2s ease-out
- hoverLift: translateY(-2px), shadow increase
- ripple: scale animation on active

### الوضع الليلي (Dark Mode)
- Background: #0F172A
- Surface: #1E293B
- Border: #334155
- Text: #F8FAFC
- Text secondary: #94A3B8
- Primary: #3B82F6
- Success: #34D399
- Danger: #F87171
- Warning: #FBBF24
- Shadows: darker variants

## الملفات المطلوبة تعديلها
1. public/index.html - إضافة رابط CSS جديد
2. public/css/modern-saas.css - ملف CSS جديد شامل
3. public/theme.js - تحديث لإدارة الثيم الجديد
4. public/theme.css - إعادة كتابة أو حذف
5. public/css/app.css - إعادة كتابة أو حذف

## الملفات الممنوع تعديلها
- server.js
- public/js/app.js
- public/js/smart-toolbar.js
- public/js/absence-helper.js
- db/database.js
- data/*
- All business logic files
