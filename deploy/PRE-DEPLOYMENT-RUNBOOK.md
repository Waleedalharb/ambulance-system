# حزمة ما قبل النشر — P1–P6

**الحالة:** جاهزة للبروفة والتنفيذ اللاحق بعد موافقة مستقلة. لم تُنفَّذ أي خطوة من هذا الدليل على الإنتاج.

## 1. حدود الحزمة

- الترحيل الإضافي: `deploy/migrations/2026-11-04-schedule-p1-p3.sql`.
- المنفذ الآمن: `scripts/migrate-schedule-p1-p3.js`.
- النسخ والاستعادة: `scripts/backup.js`.
- إعداد Render: `render.yaml`.
- بروفة آلية معزولة: `scripts/predeploy-rehearsal-test.js`.

الترحيل ينشئ **10 جداول و9 فهارس و22 Trigger** فقط. لا يدرج قيم تغطية، ولا ينشئ إصدارات أو عمليات توليد، ولا يعدّل الحسابات أو الأدوار أو المنح، ولا يكتب في `shift_roster` أو `schedule_months`.

## 2. ضوابط يجب إظهارها قبل أي نشر

1. قيم D4-C للفرق الـ44 غير معتمدة؛ تبقى `unresolved` ولا يجوز تمريرها كتغطية مكتملة.
2. النشر في P3 منطقي فقط؛ لا يطبق الجدول على roster الرسمي.
3. لا يجوز إسناد صلاحيات D5 للحسابات الفعلية ضمن النشر التقني.
4. أغلقت P5 الانحدار العام عند `209/209` بصفر إخفاقات وصفر استثناءات؛ أي تراجع لاحق يوقف البوابة.
5. مسارا `get-monthly-table` و`check-monthly-table` مربوطان بـ`schedule.view`، ولا يوجد استثناء انتقالي لتنزيل الجدول.

## 3. متطلبات Render

الإعداد الموجود في `render.yaml` يحدد:

- Node `22.14.0`، وبناء `npm ci --omit=dev`، وتشغيل `npm start`.
- فحص الصحة `/health`.
- قرصًا دائمًا `/data`، و`DB_PATH=/data/ambulance.db`.
- `DATA_DIR=/data` و`RENDER_DISK_PATH=/data`.
- `SCHEDULE_FILE=/data/schedule-employees.json` و`BACKUP_DIR=/data/backups`.
- `JWT_SECRET` وكلمات المرور الافتراضية كقيم `sync: false`؛ تُدخل في Render Dashboard ولا توضع في Git.
- `autoDeployTrigger: 'off'` حتى اعتماد النشر.

**لا تستخدم `preDeployCommand` للترحيل:** بيئة pre-deploy لا تصل إلى القرص الدائم. **لا تستخدم Render Cron Job للنسخ على `/data`:** Cron Jobs لا تركّب القرص ولا تصل إلى قرص الخدمة. النسخ المجدول يحتاج آلية خارجية موثوقة ومصادقًا عليها، أو تشغيلًا يدويًا موثقًا من Shell الخاص بالخدمة؛ لم تُنشأ آلية خارجية في هذه الحزمة.

## 4. فحص ما قبل النشر

على نسخة معزولة من الإصدار نفسه:

```bash
npm ci
node --check server.js
node --check db.js
node --check public/js/schedule-workspace.js
node scripts/p1-a-continuity-test.js
node scripts/p1-b-generation-test.js
node scripts/p2-lifecycle-test.js
node scripts/p3-workspace-test.js
node scripts/p4-browser-acceptance-test.js
node scripts/predeploy-rehearsal-test.js
node scripts/schedule-permissions-test.js
node scripts/pre-deploy-gate.js --target scripts/schedule-permissions-test.js --isolated-source-archive
```

خيار `--isolated-source-archive` مخصص لأرشيف مصدر بلا `.git`، ويجعل السجل يوثق هذه الحقيقة بدل ادعاء فحص Git؛ لا يُستخدم لتجاوز فشل Git في مستودع فعلي. لا يعتبر نجاح رفع الملفات أو `/health` وحده قبولًا؛ الخادم يبدأ الاستماع قبل اكتمال تهيئة قاعدة البيانات.

## 5. النسخة الاحتياطية والتحقق منها

من Shell الخاص بالخدمة وبعد التأكد أن متغيرات التخزين تشير إلى القرص المقصود:

```bash
node scripts/backup.js backup
node scripts/backup.js list
```

ينتج الأرشيف `backup-<timestamp>.tar.gz` ولقطة `ambulance-snapshot-<timestamp>.db`. الأرشيف يحتوي `ambulance.db` كلقطة `VACUUM INTO` متسقة، ولا يحتوي WAL/SHM الخام، ويضم ملفات JSON والمستندات والأرشيف والمرفوعات والتقارير والتصديرات الموجودة.

قبل النشر:

1. انسخ الأرشيف واللقطة إلى تخزين خارج القرص نفسه.
2. سجّل أحجام الملفات وبصمات SHA-256.
3. استخرج نسخة في بيئة منفصلة وشغّل `quick_check` واختبار استعادة فعلي.
4. وفّر مساحة للقطة والأرشيف ومجلد staging المؤقت؛ النسخ يحتاج مساحة إضافية أثناء الإنشاء.
5. لا تعتمد لقطة Render Disk وحدها لاستعادة SQLite؛ استخدم النسخة المتسقة أعلاه.

## 6. الترحيل

### فحص بلا كتابة

```bash
node scripts/migrate-schedule-p1-p3.js --db /data/ambulance.db
```

يفحص القاعدة والجداول المعتمد عليها والمخطط الحالي والبصمات، ولا ينشئ نسخة ولا يكتب.

### تطبيق مشروط بموافقة مستقلة

```bash
node scripts/migrate-schedule-p1-p3.js \
  --db /data/ambulance.db \
  --backup-dir /data/backups/pre-schedule \
  --apply
```

ينشئ نسخة SQLite متسقة قبل التغيير، ويطبق SQL داخل معاملة، ثم يطابق المخطط والبيانات المحمية ويخرج Manifest. لا تشغّله بالتوازي مع إقلاع نسخة أخرى من التطبيق. إقلاع التطبيق نفسه يشغّل `db.init(true)` وينشئ المخطط تلقائيًا؛ لا تكرر الترحيل اليدوي بلا حاجة.

### تحقق لاحق بلا كتابة

```bash
node scripts/migrate-schedule-p1-p3.js --db /data/ambulance.db --verify
```

يجب أن يكون الناتج `status=verified` وألا توجد كائنات مختلفة. أي مخطط P1–P3 قائم بصيغة مختلفة يوقف المنفذ بدل تجاوزه.

## 7. اختبار ما بعد النشر دون عمليات تشغيلية

1. `/health` يعيد `status=ok` و`storageProof.writable=true` و`persistent=true` ومسار القاعدة الصحيح.
2. `--verify` ينجح، و`quick_check` و`foreign_key_check` سليمان.
3. تسجيل الدخول والواجهة الرئيسية و`schedule-workspace.html` يعملون.
4. `/api/schedule/workspace` يرفض غير المصادق، وتظهر الفرق غير المعتمدة `unresolved`.
5. `director` لا يستطيع التوليد حتى مع منح فردي؛ التوليد يتطلب `role=admin` و`schedule.generate`.
6. صلاحيات الاعتماد والنشر مستقلة، ولا تُجرّب على شهر حقيقي.
7. لا ينفذ فريق القبول توليدًا أو اعتمادًا أو نشرًا حقيقيًا أثناء smoke test.
8. تؤخذ بصمات `shift_roster` و`schedule_months` والموظفين والحسابات والمنح قبل الاختبار وبعده ويجب أن تثبت.

## 8. التراجع

**rollback الكود وحده لا يعيد البيانات.** إذا تغيرت القاعدة أو الملفات، استخدم نسخة ما قبل النشر.

1. أوقف الكتابة والخدمة وفق إجراء Render، ولا تستعد قاعدة أثناء عمل الخادم.
2. خذ نسخة جديدة من الحالة الحالية قبل التراجع؛ قد تحتوي بيانات أنشئت بعد النشر.
3. احتفظ بالإصدار والأرشيف وManifest وسبب التراجع.
4. نفّذ من بيئة الخدمة المتوقفة:

```bash
node scripts/backup.js restore /data/backups/backup-<pre-deploy-timestamp>.tar.gz
```

الاستعادة تنشئ أولًا نسخة كاملة من الحالة الحالية، وتحقق من وجود `ambulance.db` في الأرشيف، وتحذف WAL/SHM/Journal القديمة، ثم تستخرج اللقطة وتشغّل `quick_check`. وهي استعادة تراكبية: لا تحذف ملفات إضافية ليست في الأرشيف؛ إذا لزم تطابق كامل فاستعد إلى مجلد نظيف وبدّل المسار بعد التحقق.

5. أعد الإصدار السابق من الكود، ثم شغّل فحوص الصحة وتسجيل الدخول والمخطط والبصمات.
6. إذا كان التراجع للكود فقط ولم تُنشأ بيانات P1–P3، يمكن إبقاء الجداول الإضافية الفارغة؛ لا تسقطها، لأن إسقاطها بعد وجود بيانات يفقد الأدلة.

## 9. قرار الجاهزية

هذه الحزمة تثبت صلاحية الآليات على بيانات اصطناعية معزولة فقط. النشر الفعلي يتطلب موافقة مستقلة، ونسخة إنتاج حقيقية مؤكدة الاستعادة، ومراجعة موانع الانحدار وD4-C وإسناد الحسابات. لا توجد في هذا المستند موافقة ضمنية على النشر أو التوليد أو الاعتماد أو النشر التشغيلي.

## 10. إضافة P6 — الاستيراد الذكي

- الترحيل الإضافي: `deploy/migrations/2026-11-05-schedule-p6.sql`.
- المنفذ الآمن: `scripts/migrate-schedule-p6.js`.
- البروفة المستقلة: `scripts/p6-deployment-rehearsal-test.js`.
- الاختبار الوظيفي: `scripts/smart-import-test.js`.

ينشئ الترحيل **3 جداول وفهرسين و6 Triggers** فقط: دفعات الاستيراد، والمراجعات، والقوالب البنيوية. لا يدرج قيم تغطية أو صلاحيات، ولا ينشئ مراجع جداول، ولا يكتب في `shift_roster` أو `schedule_months`.

أضف إلى فحص ما قبل النشر:

```bash
node --check public/js/schedule-import-workspace.js
node scripts/smart-import-test.js
node scripts/p6-deployment-rehearsal-test.js
```

بعد نجاح ترحيل P1–P3 وأخذ النسخة الاحتياطية، تكون أوامر P6 المستقلة:

```bash
# فحص بلا كتابة
node scripts/migrate-schedule-p6.js --db /data/ambulance.db

# تطبيق مشروط بموافقة مستقلة ونسخة احتياطية
node scripts/migrate-schedule-p6.js \
  --db /data/ambulance.db \
  --backup-dir /data/backups/pre-schedule-p6 \
  --apply

# تحقق لاحق بلا كتابة
node scripts/migrate-schedule-p6.js --db /data/ambulance.db --verify
```

بعد النشر، افتح `schedule-workspace.html` ثم تبويب «الاستيراد الذكي»، وتحقق من رفض `/api/schedule/imports` لغير المصادق ومن فصل `schedule.view` عن `schedule.import`. لا ترفع جدولًا تشغيليًا حقيقيًا ولا تنشئ مرجعًا أثناء smoke test؛ استخدم ملفًا اصطناعيًا فقط إذا سُمح باختبار الكتابة على بيئة الإنتاج. يبقى الناتج الوحيد مرجعًا بحالة `imported`، ولا يُعتمد أو يُنشر تلقائيًا.

عند التراجع، استخدم نسخة ما قبل P6 إذا لزم إعادة المخطط والبيانات. لا تسقط جداول P6 بعد وجود دفعات أو مراجعات؛ فهي أدلة محفوظة، وTriggers تمنع حذفها عمدًا.
