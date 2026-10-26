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
        List {
            Section {
                Toggle("settings.deleteLocalAfterReceipt", isOn: $settings.deleteLocalAfterReceipt)
            } header: { Text("settings.localCopies") } footer: { Text("settings.deleteLocalAfterReceipt.help") }
            Section {
                Toggle("settings.uploadOverWifiOnly", isOn: $settings.uploadOverWifiOnly)
                    .onChange(of: settings.uploadOverWifiOnly) { _, _ in queue.updateNetworkState() }
            } footer: { Text("settings.uploadOverWifiOnly.help") }
            Section {
                Toggle("settings.appLock", isOn: Binding(get: { lock.state.isEnabled }, set: { on in Task { await lock.setEnabled(on) } }))
            } footer: { Text(lock.unavailable ? LocalizedStringKey("settings.appLock.unavailable") : LocalizedStringKey("settings.appLock.help")) }
            Section("settings.session") {
                Button("settings.logout") { Task { await app.logout(allSessions: false) } }
                Button("settings.logoutAll", role: .destructive) { confirmLogoutAll = true }
            }
            Section { EmergencyWipeButton() } header: { Text("wipe.section") } footer: { Text("wipe.help") }
        }
        .tint(Color.vl.bgBrand)
        .navigationTitle("tab.settings")
        .confirmationDialog("settings.logoutAll.confirm", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
            Button("settings.logoutAll", role: .destructive) { Task { await app.logout(allSessions: true) } }
        }
    }
}
