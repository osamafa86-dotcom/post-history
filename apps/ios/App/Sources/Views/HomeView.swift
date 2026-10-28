import MaterialsCore
import SwiftUI

/// الشاشة الرئيسية بأربعة تبويبات: الرفع (A2)، موادي (A4)، الإشعارات، الإعدادات. «مادة جديدة» (A1) والإيصال (A3) أوراق فوقها.
struct HomeView: View {
    enum Tab: Hashable { case uploads, materials, notifications, settings }

    @EnvironmentObject private var queue: UploadQueueModel
    @EnvironmentObject private var notifications: NotificationsModel
    @State private var tab: Tab = .uploads
    @State private var showNewMaterial = false
    @State private var editingDraft: MaterialDraft?
    @State private var focusMaterial: UUID?

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                UploadsScreen(editingDraft: $editingDraft)
                    .navigationTitle("tab.uploads")
                    .toolbar {
                        ToolbarItem(placement: .primaryAction) {
                            Button { showNewMaterial = true } label: { Label("material.new", systemImage: "plus") }
                        }
                        // إيماءة سريعة: المسح الطارئ من شريط الأدوات أيضًا (بالتأكيد نفسه).
                        ToolbarItem(placement: .topBarLeading) { EmergencyWipeButton().labelStyle(.iconOnly) }
                    }
            }
            .tabItem { Label("tab.uploads", systemImage: "arrow.up.circle") }
            .tag(Tab.uploads)

            NavigationStack {
                MyMaterialsView(focus: $focusMaterial) { showNewMaterial = true }
                    .navigationTitle("materials.title")
            }
            .tabItem { Label("materials.title", systemImage: "tray.full") }
            .tag(Tab.materials)

            NavigationStack { NotificationsView() }
                .tabItem { Label("notifications.title", systemImage: "bell") }
                .badge(notifications.unreadCount)
                .tag(Tab.notifications)

            NavigationStack { SettingsScreen() }
                .tabItem { Label("tab.settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .tint(Color.vl.bgBrand)
        .sheet(isPresented: $showNewMaterial) { NewMaterialFlow() }
        .sheet(item: $editingDraft) { draft in NewMaterialFlow(draft: draft) }
        .sheet(item: $queue.presentedReceipt) { target in ReceiptScreen(target: target) }
        .onChange(of: notifications.presented) { _, presented in
            guard presented else { return }
            notifications.presented = false
            tab = .notifications
        }
        .onChange(of: notifications.openedMaterialId) { _, id in
            guard let id else { return }
            focusMaterial = id
            tab = .materials
        }
    }
}

/// الإعدادات كما كانت في الشاشة الرئيسية: النسخ المحلية، Wi‑Fi فقط، القفل، الجلسة، والمسح الطارئ.
struct SettingsScreen: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var lock: AppLockModel
    @EnvironmentObject private var queue: UploadQueueModel
    @State private var confirmLogoutAll = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VL.Space.s7) {
                section(title: "settings.localCopies") {
                    Toggle("settings.deleteLocalAfterReceipt", isOn: $settings.deleteLocalAfterReceipt)
                        .vlText(.labelLg).foregroundStyle(Color.vl.textPrimary)
                    helpText(Text("settings.deleteLocalAfterReceipt.help"))
                }
                section {
                    Toggle("settings.uploadOverWifiOnly", isOn: $settings.uploadOverWifiOnly)
                        .vlText(.labelLg).foregroundStyle(Color.vl.textPrimary)
                        .onChange(of: settings.uploadOverWifiOnly) { _, _ in queue.updateNetworkState() }
                    helpText(Text("settings.uploadOverWifiOnly.help"))
                }
                section {
                    Toggle("settings.appLock", isOn: Binding(get: { lock.state.isEnabled }, set: { on in Task { await lock.setEnabled(on) } }))
                        .vlText(.labelLg).foregroundStyle(Color.vl.textPrimary)
                    helpText(Text(lock.unavailable ? LocalizedStringKey("settings.appLock.unavailable") : LocalizedStringKey("settings.appLock.help")))
                }
                section(title: "settings.session") {
                    Button("settings.logout") { Task { await app.logout(allSessions: false) } }.buttonStyle(.vlSecondary)
                    Button("settings.logoutAll", role: .destructive) { confirmLogoutAll = true }.buttonStyle(.vlSecondary)
                }
                section(title: "wipe.section") {
                    EmergencyWipeButton().buttonStyle(.vlSecondary)
                    helpText(Text("wipe.help"))
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .tint(Color.vl.bgBrand)
        .navigationTitle("tab.settings")
        .confirmationDialog("settings.logoutAll.confirm", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
            Button("settings.logoutAll", role: .destructive) { Task { await app.logout(allSessions: true) } }
        }
    }

    /// مجموعة إعدادات في بطاقة، بعنوان قسم اختياري (`overline/md`) يعلنه قارئ الشاشة عنوانًا كما كان رأس القائمة.
    private func section<Content: View>(title: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            if let title { VLOverline(title).accessibilityAddTraits(.isHeader) }
            VLCard { content() }
        }
    }

    private func helpText(_ text: Text) -> some View {
        text.vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
    }
}
