//
//  AdminHubView.swift
//  EMSOperations
//
//  مركز الإدارة (§20): بوابة الشاشات الإدارية — كل موديول يظهر فقط
//  لمن يملك صلاحيته (مفتاح منح أو دور admin/director حسب المسار
//  السيرفري). إخفاء الموديول ليس حماية — الخادم يفرض في كل طلب.
//  الدخول من «ملفي» لحامل canAccessAdmin.
//

import SwiftUI

struct AdminHubView: View {
    @EnvironmentObject private var session: SessionStore

    private enum AdminModule: Hashable, Identifiable {
        case users, employees, refs, symbols, notifications, system
        var id: Self { self }

        var title: String {
            switch self {
            case .users: return "المستخدمون والأدوار"
            case .employees: return "الموظفون"
            case .refs: return "الفرق والرموز والأنماط"
            case .symbols: return "رموز الجداول"
            case .notifications: return "إشعارات النظام"
            case .system: return "الإعدادات والمراقبة"
            }
        }
        var icon: String {
            switch self {
            case .users: return "person.badge.key.fill"
            case .employees: return "person.2.fill"
            case .refs: return "list.bullet.rectangle.portrait.fill"
            case .symbols: return "lock.square.stack"
            case .notifications: return "bell.badge.fill"
            case .system: return "gearshape.2.fill"
            }
        }
        var detail: String {
            switch self {
            case .users: return "الحسابات · تغيير الدور · إنشاء حساب موظف"
            case .employees: return "إضافة وتعديل · توثيق الجوال · النقل · النمط"
            case .refs: return "الفرق · رموز المناوبات · أنماط المناوبة"
            case .symbols: return "السجل المركزي · القفل السري · سجل التعديلات"
            case .notifications: return "إرسال موجه · سجل الإرسال وتعقّب التسليم"
            case .system: return "الساعات الشهرية · استخدام القرص · سجل التدقيق"
            }
        }
    }

    /// كل موديول مقيد بمساره السيرفري:
    /// users: admin.users_manage (القراءة admin) · employees/refs: admin
    ///   (النقل/الجوال/النمط admin/director) · symbols: symbols.manage ·
    /// system: admin/director.
    private var modules: [AdminModule] {
        let p = session.permissions
        var list: [AdminModule] = []
        if p.canManageUsers || p.isAdmin { list.append(.users) }
        if p.isAdminOrDirector { list.append(.employees) }
        if p.isAdmin { list.append(.refs) }
        if p.canManageSymbols { list.append(.symbols) }
        if p.isAdminOrDirector { list.append(.notifications); list.append(.system) }
        return list
    }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                EMSCard {
                    HStack(spacing: 12) {
                        Image(systemName: "shield.lefthalf.filled")
                            .font(.title2)
                            .foregroundStyle(EMSTheme.Colors.teal)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("مركز الإدارة")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)
                            Text("الإجراءات الحساسة موثقة في سجل التدقيق — الحسم النهائي على الخادم")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                    }
                }

                ForEach(modules) { module in
                    NavigationLink(value: module) {
                        EMSCard {
                            HStack(spacing: 12) {
                                Image(systemName: module.icon)
                                    .font(.title3)
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(module.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                    Text(module.detail)
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                        .lineLimit(2)
                                }
                                Spacer()
                                Image(systemName: "chevron.left")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("الإدارة")
        .navigationDestination(for: AdminModule.self) { module in
            switch module {
            case .users: AdminUsersView()
            case .employees: AdminEmployeesView()
            case .refs: AdminRefsView()
            case .symbols: AdminSymbolsView()
            case .notifications: AdminNotificationsView()
            case .system: AdminSystemView()
            }
        }
    }
}
