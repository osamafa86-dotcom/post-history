import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var lock: AppLockModel
    @EnvironmentObject private var notifications: NotificationsModel
    @State private var confirmLogoutAll = false
    @State private var showNewMaterial = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { NotificationsView() } label: {
                        Label("notifications.title", systemImage: "bell")
                            .badge(notifications.unreadCount)
                    }
                }
                Section("home.uploads") {
                    UploadQueueView()
                }
                Section {
                    NavigationLink { MyMaterialsView() } label: { Label("materials.open", systemImage: "tray.full") }
                }
                Section {
                    Toggle("settings.deleteLocalAfterReceipt", isOn: $settings.deleteLocalAfterReceipt)
                } header: { Text("settings.localCopies") } footer: { Text("settings.deleteLocalAfterReceipt.help") }
                Section {
                    Toggle("settings.appLock", isOn: Binding(get: { lock.state.isEnabled }, set: { on in Task { await lock.setEnabled(on) } }))
                } footer: { Text(lock.unavailable ? LocalizedStringKey("settings.appLock.unavailable") : LocalizedStringKey("settings.appLock.help")) }
                Section("settings.session") {
                    Button("settings.logout") { Task { await app.logout(allSessions: false) } }
                    Button("settings.logoutAll", role: .destructive) { confirmLogoutAll = true }
                }
                Section { EmergencyWipeButton() } header: { Text("wipe.section") } footer: { Text("wipe.help") }
            }
            .navigationTitle("home.title")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNewMaterial = true } label: { Label("material.new", systemImage: "plus") }
                }
                // إيماءة سريعة: المسح الطارئ من شريط الأدوات أيضًا (بالتأكيد نفسه).
                ToolbarItem(placement: .topBarLeading) { EmergencyWipeButton().labelStyle(.iconOnly) }
            }
            .sheet(isPresented: $showNewMaterial) { NewMaterialView() }
            .sheet(isPresented: $notifications.presented) { NavigationStack { NotificationsView() } }
            .confirmationDialog("settings.logoutAll.confirm", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
                Button("settings.logoutAll", role: .destructive) { Task { await app.logout(allSessions: true) } }
            }
        }
    }
}
