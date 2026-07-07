# خطة تطوير نظام الدردشة الداخلي — منصة الجنوب

## الهدف
إضافة نظام دردشة احترافي داخل المنصة كوحدة مستقلة (Module)، مع المحافظة الكاملة على النظام الحالي.

## المبدأ الأساسي
**"لا تلمس ما يعمل"** — يُضاف نظام الدردشة كملفات جديدة فقط + تعديلات محدودة وآمنة في server.js و db.js.

---

## البنية التحتية الحالية (Context)

| المكوّن | التفاصيل |
|---------|----------|
| Backend | Node.js + Express 4.x |
| Database | SQLite (better-sqlite3) مع WAL mode |
| Auth | JWT (jsonwebtoken) — `req.user = { id, username, name, role }` |
| WebSocket | `ws` library — مسار `/ws` — `broadcast()` موجودة |
| Frontend | vanilla HTML/CSS/JS (لا React/Vue) |
| File Upload | Multer + Render Disk (`STORAGE_PATH/uploads`) |
| Users | 19 مستخدم في `users.json` + SQLite `users` table |

---

## العقد المشترك (Shared Contract)

### API Endpoints (جميعها تتطلب `authenticate` middleware)

```
GET    /api/chat/conversations              ← قائمة المحادثات
POST   /api/chat/conversations              ← إنشاء مجموعة
POST   /api/chat/conversations/private      ← بدء محادثة خاصة
GET    /api/chat/conversations/:id/messages ← رسائل محادثة (pagination)
POST   /api/chat/conversations/:id/messages ← إرسال رسالة
PUT    /api/chat/messages/:id/read          ← تم القراءة
GET    /api/chat/users                      ← قائمة المستخدمين
DELETE /api/chat/conversations/:id          ← حذف/أرشفة مجموعة (admin)
POST   /api/chat/conversations/:id/participants      ← إضافة عضو
DELETE /api/chat/conversations/:id/participants/:uid ← إزالة عضو
PUT    /api/chat/conversations/:id/leave    ← مغادرة المجموعة
```

### WebSocket Events

```javascript
// Client → Server
{ type: 'chat_typing', conversationId: '...' }
{ type: 'chat_subscribe', conversationId: '...' }

// Server → Client  
{ type: 'chat_message', conversationId: '...', message: {...} }
{ type: 'chat_typing', conversationId: '...', user: {...} }
{ type: 'chat_read', conversationId: '...', userId: '...', messageId: '...' }
{ type: 'chat_conversation_update', conversationId: '...' }
```

### Data Shapes

```javascript
// Conversation
{ id, type: 'private'|'group', title, created_by, created_at, updated_at, is_archived }

// Participant
{ id, conversation_id, user_id, joined_at, is_admin, is_muted, last_read_at }

// Message
{ id, conversation_id, sender_id, content, type: 'text'|'file'|'system'|'context',
  file_url, context_type, context_id, reply_to, created_at, edited_at, is_deleted }

// Attachment
{ id, message_id, filename, stored_name, mime_type, size, upload_date }
```

---

## التوزيع على العملاء (Subagent Slices)

### Slice 1: Backend — Database + API + WebSocket
**الملفات المستهدفة:**
- `db.js` ← إضافة جداول الدردشة في `TABLE_SCHEMAS`
- `server.js` ← إضافة API routes section (قبل error handler)
- `package.json` ← إذا احتاجت مكتبات جديدة

**ما لا يجب لمسه:**
- أي route موجود حالياً
- أي دالة مساعدة (helpers)
- WebSocket init function — فقط إضافة handler للأحداث الجديدة

**المخرجات:**
- جداول SQLite جديدة: `chat_conversations`, `chat_participants`, `chat_messages`, `chat_message_reads`, `chat_attachments`
- API routes جديدة تحت `/api/chat/*`
- WebSocket handlers للأحداث الجديدة

### Slice 2: Frontend — صفحة الدردشة الرئيسية
**الملفات المستهدفة (جديدة):**
- `public/chat.html`
- `public/js/chat.js`
- `public/css/chat.css`

**الواجهة المطلوبة:**
- الشريط الجانبي: قائمة المحادثات + عداد الرسائل غير المقروءة + بحث
- منطقة المحادثة: فقاعات رسائل + مؤشر "يكتب الآن" + إرسال ملف
- رأس المحادثة: اسم الفرقة/المستخدم + حالة الاتصال
- تكامل WebSocket للاستلام الفوري
- تصميم RTL بالكامل

**الاعتماديات:**
- Font Awesome (موجودة في index.html)
- IBM Plex Sans Arabic (موجودة)
- JWT token من `localStorage`
- WebSocket client (`ws://`)

### Slice 3: Integration — ربط الدردشة بالمنصة
**الملفات المستهدفة:**
- `public/index.html` ← إضافة أيقونة الرسائل في الشريط العلوي
- `public/js/chat.js` ← زر "إرسال للدردشة" (context share)

**المخرجات:**
- أيقونة 🔔 في الشريط العلوي لجميع الصفحات (أو index.html على الأقل)
- عداد الرسائل غير المقروءة
- زر "ناقش في الدردشة" على السجلات الرئيسية (index.html)

---

## ترتيب الدمج (Merge Order)
1. **Slice 1** (Backend) — يجب أن يكتمل أولاً
2. **Slice 2 + Slice 3** (Frontend + Integration) — يمكن العمل عليهما بالتوازي بعد اكتمال Backend

## الاختبار النهائي
- فتح صفحة الدردشة والتحقق من:
  - [ ] إنشاء محادثة خاصة
  - [ ] إرسال واستلام رسائل
  - [ ] مؤشر "يكتب الآن"
  - [ ] عداد الرسائل غير المقروءة
  - [ ] رفع ملف
  - [ ] إشعار WebSocket فوري
  - [ ] البحث في المحادثات
