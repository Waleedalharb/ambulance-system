// ============================================
// تطبيق الجنوب - حل شامل للمشاكل
// ============================================

console.log('🚀 جاري تحميل تطبيق الجنوب...');

// ============================================
// 1️⃣ إدارة الـ Modals
// ============================================

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) {
        console.error(`❌ Modal ${modalId} غير موجود`);
        return;
    }
    modal.style.display = 'flex';
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    console.log(`✅ فتح Modal: ${modalId}`);
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
        document.body.style.overflow = 'auto';
        console.log(`✅ إغلاق Modal: ${modalId}`);
    }
}

// إغلاق الـ Modal عند النقر خارجه
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('[data-modal]').forEach(modal => {
        modal.addEventListener('click', function(event) {
            if (event.target === this) {
                closeModal(this.id);
            }
        });
    });
});

// ============================================
// 2️⃣ المناوبات السابقة (Archive Shifts)
// ============================================

async function showArchiveShifts() {
    console.log('🔄 جاري تحميل المناوبات السابقة...');
    try {
        // جلب من API الخادم
        const response = await fetch('/api/shifts', {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`خطأ HTTP: ${response.status}`);
        }

        const shifts = await response.json();
        console.log('📊 المناوبات المحملة:', shifts.length);

        const tbody = document.getElementById('archiveShiftsBody');
        if (!tbody) {
            console.error('❌ جدول المناوبات غير موجود');
            return;
        }

        tbody.innerHTML = '';

        if (!Array.isArray(shifts) || shifts.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 20px; color: var(--gray-600);">
                        📭 لا توجد مناوبات سابقة
                    </td>
                </tr>
            `;
            console.log('⚠️ لا توجد مناوبات مسجلة');
        } else {
            shifts.forEach((shift, index) => {
                const row = document.createElement('tr');
                const shiftDate = shift.shiftDate || formatDate(shift.startTime);
                const shiftType = shift.shiftType === 'morning' ? '☀️ صباحية' : '🌙 ليلية';
                const total = shift.totalReports || 0;

                row.innerHTML = `
                    <td>${index + 1}</td>
                    <td>${shiftDate}</td>
                    <td>${shiftType}</td>
                    <td>${total} بلاغ</td>
                    <td>
                        <button onclick="viewShiftDetails('${shift.id}')" 
                                style="background: var(--primary-100); color: var(--primary-700); border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: 600;">
                            👁️ عرض
                        </button>
                    </td>
                `;
                tbody.appendChild(row);
            });
            console.log(`✅ تم تحميل ${shifts.length} مناوبة`);
        }

        openModal('archiveShiftsModal');
    } catch (error) {
        console.error('❌ خطأ في تحميل المناوبات:', error);
        alert('⚠️ خطأ في تحميل المناوبات السابقة: ' + error.message);
    }
}

function viewShiftDetails(shiftId) {
    console.log(`📋 عرض تفاصيل المناوبة: ${shiftId}`);
    alert(`تفاصيل المناوبة: ${shiftId}\n\nقريباً: سيتم إضافة عرض التفاصيل الكامل`);
}

function formatDate(dateString) {
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('ar-SA');
    } catch (e) {
        return dateString;
    }
}

// ============================================
// 3️⃣ كبار المسعفين والتوقيعات
// ============================================

async function showChiefParamedics() {
    console.log('🔄 جاري تحميل كبار المسعفين...');
    try {
        const response = await fetch('/api/chiefs', {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok && response.status !== 404) {
            throw new Error(`خطأ HTTP: ${response.status}`);
        }

        let chiefs = [];
        if (response.ok) {
            chiefs = await response.json();
        }

        console.log('👨‍⚕️ كبار المسعفين المحملون:', chiefs.length);

        const content = document.getElementById('chiefParamedicsContent');
        if (!content) {
            console.error('❌ محتوى كبار المسعفين غير موجود');
            return;
        }

        content.innerHTML = '';

        if (!Array.isArray(chiefs) || chiefs.length === 0) {
            content.innerHTML = `
                <div style="text-align: center; color: var(--gray-600); padding: 30px;">
                    <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: 10px;"></i>
                    <p>📭 لا يوجد كبار مسعفين مسجلة</p>
                    <button onclick="addNewChief()" 
                            style="margin-top: 15px; background: var(--primary-700); color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: 600;">
                        ➕ إضافة كبير مسعفين
                    </button>
                </div>
            `;
        } else {
            chiefs.forEach((chief, index) => {
                const chiefDiv = document.createElement('div');
                chiefDiv.style.cssText = `
                    background: var(--gray-50);
                    padding: 15px;
                    border-radius: 12px;
                    margin-bottom: 15px;
                    border-left: 4px solid var(--primary-500);
                    transition: all 0.3s;
                `;
                chiefDiv.onmouseover = () => chiefDiv.style.boxShadow = 'var(--shadow-md)';
                chiefDiv.onmouseout = () => chiefDiv.style.boxShadow = 'none';

                const signatureStatus = chief.signature ? '✅ موقع' : '⏳ في الانتظار';
                const signatureColor = chief.signature ? 'var(--teal)' : 'var(--coral)';

                chiefDiv.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <h3 style="font-size: 0.95rem; color: var(--primary-700); margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
                                👨‍⚕️ ${chief.name || 'غير محدد'}
                                <span style="font-size: 0.75rem; background: ${signatureColor}20; color: ${signatureColor}; padding: 2px 8px; border-radius: 12px;">
                                    ${signatureStatus}
                                </span>
                            </h3>
                            <p style="font-size: 0.85rem; color: var(--gray-600); margin: 4px 0;">
                                <strong>📍 القطاع:</strong> ${chief.sector || 'غير محدد'}
                            </p>
                            <p style="font-size: 0.85rem; color: var(--gray-600); margin: 4px 0;">
                                <strong>📅 التاريخ:</strong> ${chief.dateDisplay || formatDate(chief.date)}
                            </p>
                        </div>
                        <button onclick="deleteChief('${chief.id}')" 
                                style="background: var(--coral-light); color: var(--coral); border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: 600;">
                            🗑️ حذف
                        </button>
                    </div>
                `;
                content.appendChild(chiefDiv);
            });
            console.log(`✅ تم تحميل ${chiefs.length} كبير مسعفين`);
        }

        openModal('chiefParamedicsModal');
    } catch (error) {
        console.error('❌ خطأ في تحميل كبار المسعفين:', error);
        alert('⚠️ خطأ في تحميل كبار المسعفين: ' + error.message);
    }
}

async function addNewChief() {
    const name = prompt('👨‍⚕️ أدخل اسم كبير المسعفين:');
    if (!name) return;

    const sector = prompt('📍 أدخل القطاع:');
    if (!sector) return;

    try {
        const response = await fetch('/api/chiefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, sector })
        });
        if (!response.ok) throw new Error(`خطأ HTTP: ${response.status}`);
        const result = await response.json();
        if (result.success) {
            showChiefParamedics();
        } else {
            alert('فشل في إضافة كبير المسعفين: ' + (result.error || 'خطأ غير معروف'));
        }
    } catch (error) {
        console.error('❌ خطأ في إضافة كبير المسعفين:', error);
        alert('خطأ في الاتصال: ' + error.message);
    }
}

async function deleteChief(chiefId) {
    if (!confirm('هل أنت متأكد من حذف كبير المسعفين؟')) return;
    try {
        const response = await fetch('/api/chiefs/' + chiefId, { method: 'DELETE' });
        if (!response.ok) throw new Error(`خطأ HTTP: ${response.status}`);
        const result = await response.json();
        if (result.success) {
            showChiefParamedics();
        } else {
            alert('فشل في حذف كبير المسعفين');
        }
    } catch (error) {
        console.error('❌ خطأ في حذف كبير المسعفين:', error);
        alert('خطأ في الاتصال: ' + error.message);
    }
}

// ============================================
// 4️⃣ مزامنة الثيمات
// ============================================

async function syncThemeFromServer() {
    console.log('🔄 جاري مزامنة الثيمات من الخادم...');
    try {
        const response = await fetch('/api/theme-settings', {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`خطأ HTTP: ${response.status}`);
        }

        const { data } = await response.json();

        if (data) {
            // حفظ محليًا
            localStorage.setItem('themeData', JSON.stringify(data));
            sessionStorage.setItem('themeData', JSON.stringify(data));

            // تطبيق الثيم
            applyTheme(data);
            console.log('✅ تم مزامنة الثيمات بنجاح');
        }
    } catch (error) {
        console.warn('⚠️ خطأ في مزامنة الثيمات من الخادم، جاري استخدام النسخة المحلية:', error);

        // محاولة من التخزين المحلي
        const savedTheme = localStorage.getItem('themeData');
        if (savedTheme) {
            applyTheme(JSON.parse(savedTheme));
            console.log('✅ تم تطبيق الثيمات من التخزين المحلي');
        }
    }
}

function applyTheme(themeData) {
    if (!themeData) return;

    const header = document.querySelector('.header');
    if (!header) {
        console.warn('⚠️ عنصر Header غير موجود');
        return;
    }

    console.log('🎨 تطبيق الثيمات:', themeData);

    // تطبيق خلفية الرأس
    if (themeData.headerBg) {
        if (themeData.headerBgType === 'image') {
            header.style.backgroundImage = `url('${themeData.headerBg}')`;
            header.style.backgroundSize = 'cover';
            header.style.backgroundPosition = 'center';
            header.classList.add('has-bg-image');
        } else if (themeData.headerBgType === 'color') {
            header.style.backgroundColor = themeData.headerBg;
            header.style.backgroundImage = 'none';
            header.classList.remove('has-bg-image');
        }
    }

    // تطبيق الشعار
    if (themeData.sectorLogo) {
        const logoImg = document.querySelector('.header-brand .icon img');
        if (logoImg) {
            logoImg.src = themeData.sectorLogo;
            logoImg.onerror = () => {
                console.warn('⚠️ فشل في تحميل الشعار');
            };
        }
    }

    // تطبيق وضع الثيم
    if (themeData.themeMode === 'on') {
        header.classList.add('theme-mode');
    } else {
        header.classList.remove('theme-mode');
    }

    console.log('✅ تم تطبيق الثيمات بنجاح');
}

// ============================================
// 5️⃣ الاتصال بـ SSE للمزامنة الفورية
// ============================================

function connectThemeUpdates() {
    console.log('🔗 جاري الاتصال بنظام المزامنة الفورية...');
    try {
        const eventSource = new EventSource('/api/theme-updates');

        eventSource.onopen = () => {
            console.log('✅ متصل بنظام المزامنة الفورية');
        };

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('📡 رسالة من الخادم:', data);

                if (data.type === 'theme_updated') {
                    console.log('🎨 تحديث الثيم وارد من الخادم');
                    applyTheme(data.data);
                }
            } catch (e) {
                console.error('❌ خطأ في معالجة الرسالة:', e);
            }
        };

        eventSource.onerror = (error) => {
            console.error('❌ خطأ في الاتصال:', error);
            eventSource.close();
            // محاولة إعادة الاتصال بعد 5 ثوان
            setTimeout(() => connectThemeUpdates(), 5000);
        };
    } catch (error) {
        console.error('❌ خطأ في إنشاء الاتصال:', error);
    }
}

// ============================================
// 6️⃣ المزامنة الشاملة
// ============================================

async function syncAllData() {
    console.log('🔄 جاري مزامنة جميع البيانات...');
    try {
        const response = await fetch('/api/sync-all', {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`خطأ HTTP: ${response.status}`);
        }

        const syncData = await response.json();

        if (syncData) {
            localStorage.setItem('syncedData', JSON.stringify(syncData));
            sessionStorage.setItem('lastSync', new Date().toISOString());
            console.log('✅ تم مزامنة البيانات بنجاح');
        }
    } catch (error) {
        console.warn('⚠️ خطأ في المزامنة الشاملة:', error);
    }
}

// ============================================
// 7️⃣ التهيئة الأولية
// ============================================

function initializeApp() {
    console.log('🚀 جاري تهيئة التطبيق...');

    // مزامنة البيانات من الخادم عند التحميل
    syncThemeFromServer();
    syncAllData();

    // الاتصال بنظام المزامنة الفورية
    connectThemeUpdates();

    // مزامنة دورية (كل 30 ثانية)
    setInterval(() => {
        syncThemeFromServer();
    }, 30000);

    // مزامنة دورية شاملة (كل دقيقة)
    setInterval(() => {
        syncAllData();
    }, 60000);

    // إضافة event listeners
    setupEventListeners();

    console.log('✅ تم تهيئة التطبيق بنجاح');
}

function setupEventListeners() {
    // أزرار المناوبات السابقة
    const archiveBtn = document.querySelector('[data-action="archive"]');
    if (archiveBtn) {
        archiveBtn.addEventListener('click', showArchiveShifts);
    }

    // أزرار كبار المسعفين
    const chiefBtn = document.querySelector('[data-action="chief"]');
    if (chiefBtn) {
        chiefBtn.addEventListener('click', showChiefParamedics);
    }

    console.log('✅ تم إضافة Event Listeners');
}

// ============================================
// تشغيل التطبيق عند تحميل الصفحة
// ============================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

console.log('✅ تم تحميل app.js بنجاح');
